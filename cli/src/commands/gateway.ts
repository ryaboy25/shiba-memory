import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { cors } from "hono/cors";
import { z } from "zod";
import { timingSafeEqual } from "crypto";
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "fs";
import pino from "pino";
import { query, disconnect } from "../db.js";
import { remember } from "./remember.js";
import { recall } from "./recall.js";
import { forget } from "./forget.js";
import { linkMemories, getRelated, autoLinkAll } from "./link.js";
import { getStats, decayMemories, consolidate } from "./reflect.js";

import type { Context, Next } from "hono";
import type { Server } from "http";

// ── Config ──────────────────────────────────────────────────
const PORT = parseInt(process.env.SHB_GATEWAY_PORT || "18789");
const BIND_HOST = process.env.SHB_GATEWAY_HOST || "0.0.0.0";
const API_KEY = process.env.SHB_API_KEY || "";
const PID_FILE = "/tmp/shiba-gateway.pid";
const CORS_ORIGIN = process.env.SHB_CORS_ORIGIN || "*";
const MAX_BODY_BYTES = parseInt(process.env.SHB_MAX_BODY_BYTES || "1048576");
const RATE_LIMIT_RPM = parseInt(process.env.SHB_RATE_LIMIT_RPM || "120");

const logger = pino({ level: process.env.SHB_LOG_LEVEL || "info" });

// ── Zod Schemas ─────────────────────────────────────────────

const RememberSchema = z.object({
  type: z.enum(["user", "feedback", "project", "reference", "episode", "skill", "instinct"]).default("reference"),
  title: z.string().min(1).max(500).default("Gateway memory"),
  content: z.string().min(1).max(50000),
  tags: z.array(z.string().max(100)).default(["gateway"]),
  importance: z.number().min(0).max(1).default(0.5),
  confidence: z.number().min(0.025).max(0.975).optional(),
  source: z.string().max(50).default("gateway"),
  expires_in: z.string().max(20).optional(),
  profile: z.string().max(50).optional(),
  project_path: z.string().max(500).optional(),
  user_id: z.string().max(100).default("default"),
  agent_id: z.string().max(100).default("default"),
  created_at: z.string().datetime({ offset: true }).optional(),   // Override created_at for temporal ordering
  temporal_ref: z.string().datetime({ offset: true }).optional(),  // What time period this memory refers to
  extract: z.boolean().default(false), // Auto-extract facts from content before storing
  auto_importance: z.boolean().default(false), // Auto-estimate importance via LLM/heuristic
});

const RecallSchema = z.object({
  query: z.string().min(1).max(2000),
  type: z.string().optional(),
  tags: z.array(z.string()).optional(),
  limit: z.number().int().min(1).max(100).default(5),
  semantic_weight: z.number().min(0).max(1).optional(),
  fulltext_weight: z.number().min(0).max(1).optional(),
  profile: z.string().optional(),
  project: z.string().optional(),
  user_id: z.string().max(100).optional(),
  agent_id: z.string().max(100).optional(),
  // Temporal search
  after: z.string().datetime({ offset: true }).optional(),   // ISO 8601 — only memories after this date
  before: z.string().datetime({ offset: true }).optional(),  // ISO 8601 — only memories before this date
  // Cross-encoder reranking
  rerank: z.boolean().default(false),
  // Context expansion: enrich results with surrounding session turns
  expand_context: z.boolean().default(false),
});

const ForgetSchema = z.object({
  id: z.string().uuid().optional(),
  type: z.string().optional(),
  older_than: z.string().optional(),
  low_confidence: z.number().optional(),
  expired: z.boolean().optional(),
});

const LinkSchema = z.object({
  source_id: z.string().uuid(),
  target_id: z.string().uuid(),
  relation: z.enum(["related", "supports", "contradicts", "supersedes", "caused_by", "derived_from"]),
  strength: z.number().min(0).max(1).default(0.5),
});

const EventSchema = z.object({
  source: z.string().max(100).default("gateway"),
  event_type: z.string().max(100).default("message"),
  payload: z.unknown().optional(),
});

const ProcessEventsSchema = z.object({
  ids: z.array(z.number().int()),
});

const WebhookSchema = z.object({
  source: z.string().optional(),
  event_type: z.string().optional(),
  type: z.string().optional(),
  message: z.string().optional(),
  text: z.string().optional(),
  content: z.string().optional(),
}).passthrough();

const ChannelSchema = z.object({
  channel: z.string().default("unknown"),
  sender: z.string().default("unknown"),
  message: z.string().default(""),
});

const UuidParam = z.string().uuid();

// ── Helpers ─────────────────────────────────────────────────

/**
 * Timing-safe string comparison for API key auth.
 * When lengths differ, we still perform a timingSafeEqual against a dummy buffer
 * to consume the same CPU time as a real comparison — preventing timing attacks
 * from leaking the key length.
 */
function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // Waste time on a dummy comparison to prevent length-based timing leaks
    timingSafeEqual(bufA, Buffer.alloc(bufA.length));
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

// ── Rate Limiter ────────────────────────────────────────────
const MAX_RATE_BUCKETS = 10_000; // Prevent unbounded memory growth
const rateBuckets = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const bucket = rateBuckets.get(ip);
  if (!bucket || now >= bucket.resetAt) {
    // Evict oldest entries if we hit the cap (prevents memory leak from many IPs)
    if (rateBuckets.size >= MAX_RATE_BUCKETS) {
      const oldest = rateBuckets.keys().next().value;
      if (oldest !== undefined) rateBuckets.delete(oldest);
    }
    rateBuckets.set(ip, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  bucket.count++;
  return bucket.count <= RATE_LIMIT_RPM;
}

// Clean stale buckets every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, bucket] of rateBuckets) {
    if (now >= bucket.resetAt) rateBuckets.delete(ip);
  }
}, 300_000).unref();

// ── Middleware ───────────────────────────────────────────────

async function authMiddleware(c: Context, next: Next) {
  if (!API_KEY) return next();
  const provided = c.req.header("x-shiba-key")
    || c.req.header("x-shb-key")
    || c.req.header("authorization")?.replace("Bearer ", "");
  if (provided && safeCompare(provided, API_KEY)) return next();
  logger.warn({ path: c.req.path, ip: c.req.header("x-forwarded-for") }, "auth_failed");
  return c.json({ status: "error", code: "UNAUTHORIZED", message: "Set X-Shiba-Key header" }, 401);
}

async function rateLimitMiddleware(c: Context, next: Next) {
  const ip = c.req.header("x-forwarded-for") || c.req.header("x-real-ip") || "unknown";
  // Skip rate limiting for localhost/loopback (benchmarks, internal tools)
  if (ip === "unknown" || ip === "127.0.0.1" || ip === "::1" || ip === "localhost") {
    return next();
  }
  if (!checkRateLimit(ip)) {
    logger.warn({ ip, path: c.req.path }, "rate_limited");
    return c.json({ status: "error", code: "RATE_LIMITED", message: "Too many requests" }, 429);
  }
  return next();
}

async function requestLogger(c: Context, next: Next) {
  const start = Date.now();
  await next();
  const ms = Date.now() - start;
  logger.info({
    method: c.req.method,
    path: c.req.path,
    status: c.res.status,
    ms,
  }, "request");
}

async function bodySizeMiddleware(c: Context, next: Next) {
  // Check Content-Length header first (fast path)
  const contentLength = c.req.header("content-length");
  if (contentLength && parseInt(contentLength) > MAX_BODY_BYTES) {
    return c.json({ status: "error", code: "PAYLOAD_TOO_LARGE", message: "Body exceeds size limit" }, 413);
  }
  // For requests without Content-Length, we rely on Hono's body parsing
  // to fail if the body is too large. Clone + check for streaming bodies:
  if (c.req.method === "POST" || c.req.method === "PUT" || c.req.method === "PATCH") {
    if (!contentLength) {
      // No Content-Length: read body and check size
      try {
        const body = await c.req.text();
        if (body.length > MAX_BODY_BYTES) {
          return c.json({ status: "error", code: "PAYLOAD_TOO_LARGE", message: "Body exceeds size limit" }, 413);
        }
      } catch {
        return c.json({ status: "error", code: "BAD_REQUEST", message: "Failed to read request body" }, 400);
      }
    }
  }
  return next();
}

// ── Validation ──────────────────────────────────────────────

class ValidationError extends Error {
  constructor(public code: string, message: string, public errors?: { path: string; message: string }[]) {
    super(message);
  }
}

async function parseAndValidate<T>(c: Context, schema: z.ZodSchema<T>): Promise<T> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new ValidationError("INVALID_JSON", "Invalid JSON body");
  }
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new ValidationError(
      "VALIDATION_ERROR",
      "Invalid request body",
      result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    );
  }
  return result.data;
}

// ── App ─────────────────────────────────────────────────────

function createApp() {
  const app = new Hono();

  // Global middleware
  app.use("*", cors({ origin: CORS_ORIGIN }));
  app.use("*", requestLogger);
  app.use("*", bodySizeMiddleware);
  app.use("*", rateLimitMiddleware);

  // Health — no auth
  app.get("/health", async (c) => {
    let dbLatencyMs = -1;
    try {
      const start = Date.now();
      await query("SELECT 1");
      dbLatencyMs = Date.now() - start;
    } catch { /* db down */ }
    return c.json({
      status: "ok",
      uptime_seconds: Math.floor(process.uptime()),
      db_latency_ms: dbLatencyMs,
    });
  });

  // Auth required for everything below
  app.use("*", authMiddleware);

  // ── Status ──────────────────────────────────────────────
  app.get("/status", async (c) => {
    const stats = await getStats();
    const events = await query<{ count: string }>(
      `SELECT COUNT(*)::TEXT as count FROM events_queue WHERE NOT processed`
    );
    return c.json({
      status: "ok",
      brain: stats,
      pending_events: parseInt(events.rows[0].count),
      uptime_seconds: Math.floor(process.uptime()),
    });
  });

  // ── Remember ────────────────────────────────────────────
  app.post("/remember", async (c) => {
    const body = await parseAndValidate(c, RememberSchema);

    // Auto-estimate importance if requested
    let importance = body.importance;
    if (body.auto_importance) {
      try {
        const { estimateImportance } = await import("../extraction/importance.js");
        importance = await estimateImportance(body.type, body.title, body.content);
      } catch (err) {
        logger.warn({ error: (err as Error).message }, "importance_estimation_failed");
      }
    }

    const id = await remember({
      type: body.type,
      title: body.title,
      content: body.content,
      tags: body.tags,
      importance,
      confidence: body.confidence,
      source: body.source,
      expiresIn: body.expires_in,
      profile: body.profile,
      projectPath: body.project_path,
      temporalRef: body.temporal_ref,
      createdAt: body.created_at,
      userId: body.user_id,
      agentId: body.agent_id,
    });

    // Optional: extract additional facts from the content
    let extracted = 0;
    if (body.extract) {
      try {
        const { extractPatterns } = await import("../extraction/patterns.js");
        const facts = extractPatterns(body.content, "user");
        for (const fact of facts) {
          await remember({
            type: fact.type,
            title: fact.title,
            content: fact.content,
            tags: [...fact.tags, ...(body.tags || [])],
            importance: fact.confidence,
            source: "extraction",
            userId: body.user_id,
            agentId: body.agent_id,
          });
          extracted++;
        }
      } catch (err) { logger.debug({ error: (err as Error).message }, "extraction_skipped"); }
    }

    return c.json({ status: "ok", id, extracted });
  });

  // ── Recall ──────────────────────────────────────────────
  app.post("/recall", async (c) => {
    const body = await parseAndValidate(c, RecallSchema);

    const results = await recall({
      query: body.query,
      type: body.type,
      tags: body.tags,
      limit: body.limit,
      semanticWeight: body.semantic_weight,
      fulltextWeight: body.fulltext_weight,
      profile: body.profile,
      project: body.project,
      userId: body.user_id,
      agentId: body.agent_id,
      after: body.after,
      before: body.before,
      rerank: body.rerank,
      expandContext: body.expand_context,
    });
    return c.json({ status: "ok", count: results.length, memories: results });
  });

  // ── Forget ──────────────────────────────────────────────
  app.post("/forget", async (c) => {
    const body = await parseAndValidate(c, ForgetSchema);

    const count = await forget({
      id: body.id,
      type: body.type,
      olderThan: body.older_than,
      lowConfidence: body.low_confidence,
      expired: body.expired,
    });
    return c.json({ status: "ok", deleted: count });
  });

  // ── Memory by ID ────────────────────────────────────────
  app.get("/memory/:id", async (c) => {
    const id = c.req.param("id");
    const parsed = UuidParam.safeParse(id);
    if (!parsed.success) return c.json({ status: "error", code: "INVALID_ID", message: "Invalid UUID" }, 400);

    const result = await query<{
      id: string; type: string; title: string; content: string;
      tags: string[]; importance: number; confidence: number;
      metadata: Record<string, unknown>; profile: string;
      project_path: string | null; created_at: string;
      last_accessed_at: string | null; access_count: number;
    }>(
      `SELECT id, type, title, content, tags, importance, confidence,
              metadata, profile, project_path, created_at,
              last_accessed_at, access_count
       FROM memories WHERE id = $1`, [id]
    );
    if (result.rows.length === 0) {
      return c.json({ status: "error", code: "NOT_FOUND", message: "Memory not found" }, 404);
    }
    await query(`SELECT touch_memory($1)`, [id]);
    return c.json({ status: "ok", memory: result.rows[0] });
  });

  app.delete("/memory/:id", async (c) => {
    const id = c.req.param("id");
    const parsed = UuidParam.safeParse(id);
    if (!parsed.success) return c.json({ status: "error", code: "INVALID_ID", message: "Invalid UUID" }, 400);

    const count = await forget({ id });
    return c.json({ status: "ok", deleted: count });
  });

  // ── Links ───────────────────────────────────────────────
  app.post("/link", async (c) => {
    const body = await parseAndValidate(c, LinkSchema);

    await linkMemories(body.source_id, body.target_id, body.relation, body.strength);
    return c.json({ status: "ok" });
  });

  app.get("/links/:id", async (c) => {
    const id = c.req.param("id");
    const parsed = UuidParam.safeParse(id);
    if (!parsed.success) return c.json({ status: "error", code: "INVALID_ID", message: "Invalid UUID" }, 400);

    const links = await getRelated(id);
    return c.json({ status: "ok", links });
  });

  app.post("/link/auto", async (c) => {
    const count = await autoLinkAll();
    return c.json({ status: "ok", links_created: count });
  });

  // ── Reflect ─────────────────────────────────────────────
  app.post("/reflect/consolidate", async (c) => {
    const result = await consolidate();
    return c.json({ status: "ok", ...result });
  });

  app.post("/reflect/decay", async (c) => {
    const result = await decayMemories();
    return c.json({ status: "ok", ...result });
  });

  // ── Events ──────────────────────────────────────────────
  app.post("/event", async (c) => {
    const body = await parseAndValidate(c, EventSchema);

    await query(
      `INSERT INTO events_queue (source, event_type, payload) VALUES ($1, $2, $3::jsonb)`,
      [body.source, body.event_type, JSON.stringify(body.payload || {})]
    );
    return c.json({ status: "ok", queued: true });
  });

  app.get("/events", async (c) => {
    const events = await query<{
      id: number; source: string; event_type: string; payload: unknown; created_at: string;
    }>(
      `SELECT id, source, event_type, payload, created_at
       FROM events_queue WHERE NOT processed
       ORDER BY created_at ASC LIMIT 50`
    );
    return c.json({ status: "ok", events: events.rows });
  });

  app.post("/events/process", async (c) => {
    const body = await parseAndValidate(c, ProcessEventsSchema);

    if (body.ids.length > 0) {
      await query(
        `UPDATE events_queue SET processed = true, processed_at = now() WHERE id = ANY($1::bigint[])`,
        [body.ids]
      );
    }
    return c.json({ status: "ok", processed: body.ids.length });
  });

  // ── Webhook ─────────────────────────────────────────────
  app.post("/webhook", async (c) => {
    const body = await parseAndValidate(c, WebhookSchema);

    const source = body.source || c.req.header("x-webhook-source") || "webhook";
    const eventType = body.event_type || body.type || "webhook";

    await query(
      `INSERT INTO events_queue (source, event_type, payload) VALUES ($1, $2, $3::jsonb)`,
      [source, eventType, JSON.stringify(body)]
    );

    const message = body.message || body.text || body.content;
    if (message && message.length > 20) {
      await remember({
        type: "episode",
        title: `Webhook: ${source} ${eventType}`,
        content: message.slice(0, 2000),
        tags: ["webhook", source, eventType],
        importance: 0.5,
        source: "gateway",
        expiresIn: "7d",
      });
    }

    return c.json({ status: "ok", queued: true, source, event_type: eventType });
  });

  // ── Channel ─────────────────────────────────────────────
  app.post("/channel", async (c) => {
    const body = await parseAndValidate(c, ChannelSchema);


    await query(
      `INSERT INTO events_queue (source, event_type, payload) VALUES ($1, 'channel_message', $2::jsonb)`,
      [`channel:${body.channel}`, JSON.stringify(body)]
    );

    await remember({
      type: "episode",
      title: `Channel message from ${body.sender} via ${body.channel}`,
      content: body.message.slice(0, 2000),
      tags: ["channel", body.channel, body.sender],
      importance: 0.6,
      source: "gateway",
      expiresIn: "30d",
    });

    return c.json({ status: "ok", channel: body.channel, sender: body.sender, queued: true });
  });

  // ── Webhook Subscriptions ────────────────────────────────

  const WebhookSubscribeSchema = z.object({
    url: z.string().url(),
    events: z.array(z.string()).default(["memory.created", "memory.updated", "memory.deleted"]),
    secret: z.string().optional(),
  });

  app.post("/webhooks/subscribe", async (c) => {
    const body = await parseAndValidate(c, WebhookSubscribeSchema);
    const result = await query<{ id: number }>(
      `INSERT INTO webhook_subscriptions (url, events, secret) VALUES ($1, $2, $3) RETURNING id`,
      [body.url, body.events, body.secret || null]
    );
    return c.json({ status: "ok", id: result.rows[0].id });
  });

  app.get("/webhooks", async (c) => {
    const result = await query(
      `SELECT id, url, events, active, created_at FROM webhook_subscriptions ORDER BY created_at DESC`
    );
    return c.json({ status: "ok", webhooks: result.rows });
  });

  app.delete("/webhooks/:id", async (c) => {
    const id = parseInt(c.req.param("id"));
    if (isNaN(id)) {
      return c.json({ status: "error", code: "INVALID_ID", message: "Invalid webhook ID" }, 400);
    }
    const result = await query(`DELETE FROM webhook_subscriptions WHERE id = $1`, [id]);
    if ((result.rowCount ?? 0) === 0) {
      return c.json({ status: "error", code: "NOT_FOUND", message: "Webhook not found" }, 404);
    }
    return c.json({ status: "ok", deleted: true });
  });

  // ── Session Management ───────────────────────────────────

  const SessionCreateSchema = z.object({
    session_id: z.string().min(1).max(200),
    user_id: z.string().max(100).default("default"),
    agent_id: z.string().max(100).default("default"),
    project_path: z.string().optional(),
    metadata: z.record(z.string(), z.unknown()).default({}),
  });

  app.post("/sessions", async (c) => {
    const body = await parseAndValidate(c, SessionCreateSchema);
    // Use (session_id, user_id) scoped conflict to prevent cross-user data merging.
    // Falls back to session_id-only conflict for backward compat with old schema.
    const result = await query<{ id: string }>(
      `INSERT INTO conversations (session_id, user_id, agent_id, project_path, metadata)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (session_id, user_id) DO UPDATE SET metadata = conversations.metadata || $5
       RETURNING id`,
      [body.session_id, body.user_id, body.agent_id, body.project_path || null, JSON.stringify(body.metadata)]
    );
    return c.json({ status: "ok", id: result.rows[0].id, session_id: body.session_id });
  });

  app.get("/sessions", async (c) => {
    const userId = c.req.query("user_id") || null;
    const limit = Math.min(parseInt(c.req.query("limit") || "20") || 20, 100);
    let sql = `SELECT id, session_id, summary, project_path, user_id, agent_id, started_at, ended_at, metadata
               FROM conversations WHERE 1=1`;
    const params: unknown[] = [];
    let idx = 1;
    if (userId) { sql += ` AND user_id = $${idx++}`; params.push(userId); }
    sql += ` ORDER BY started_at DESC LIMIT $${idx++}`;
    params.push(limit);
    const result = await query(sql, params);
    return c.json({ status: "ok", count: result.rows.length, sessions: result.rows });
  });

  app.get("/sessions/:id", async (c) => {
    const sessionId = c.req.param("id");
    const conv = await query(
      `SELECT id, session_id, summary, project_path, user_id, agent_id,
              started_at, ended_at, files_touched, key_decisions, metadata
       FROM conversations WHERE session_id = $1`,
      [sessionId]
    );
    if (conv.rows.length === 0) {
      return c.json({ status: "error", code: "NOT_FOUND", message: "Session not found" }, 404);
    }
    // Get memories associated with this session
    const memories = await query(
      `SELECT m.id, m.type, m.title, m.created_at FROM memories m
       JOIN conversation_memories cm ON cm.memory_id = m.id
       WHERE cm.conversation_id = $1
       ORDER BY m.created_at DESC LIMIT 50`,
      [conv.rows[0].id]
    );
    return c.json({ status: "ok", session: conv.rows[0], memories: memories.rows });
  });

  app.post("/sessions/:id/end", async (c) => {
    const sessionId = c.req.param("id");
    await query(
      `UPDATE conversations SET ended_at = now() WHERE session_id = $1`,
      [sessionId]
    );
    return c.json({ status: "ok", session_id: sessionId, ended: true });
  });

  // ── Graph Endpoints (Dashboard) ──────────────────────────

  app.get("/graph/nodes", async (c) => {
    const type = c.req.query("type") || null;
    const project = c.req.query("project") || null;
    const minConfidence = parseFloat(c.req.query("min_confidence") || "0");
    const since = c.req.query("since") || null;

    let sql = `SELECT id, type, title, content, confidence, access_count, importance,
                      tags, profile, project_path, created_at, temporal_ref
               FROM memories WHERE 1=1`;
    const params: unknown[] = [];
    let idx = 1;

    if (type) { sql += ` AND type = $${idx++}`; params.push(type); }
    if (project) { sql += ` AND project_path = $${idx++}`; params.push(project); }
    if (minConfidence > 0) { sql += ` AND confidence >= $${idx++}`; params.push(minConfidence); }
    if (since) { sql += ` AND created_at >= $${idx++}`; params.push(since); }
    sql += ` ORDER BY created_at DESC LIMIT 500`;

    const result = await query<{
      id: string; type: string; title: string; content: string;
      confidence: number; access_count: number; importance: number;
      tags: string[]; profile: string; project_path: string | null;
      created_at: string; temporal_ref: string | null;
    }>(sql, params);

    return c.json({ status: "ok", count: result.rows.length, nodes: result.rows });
  });

  app.get("/graph/edges", async (c) => {
    const result = await query<{
      source_id: string; target_id: string; relation: string; strength: number; created_at: string;
    }>(
      `SELECT source_id, target_id, relation, strength, created_at
       FROM memory_links
       ORDER BY created_at DESC
       LIMIT 2000`
    );

    const edges = result.rows.map((r) => ({
      source: r.source_id,
      target: r.target_id,
      relation: r.relation,
      strength: r.strength,
    }));

    return c.json({ status: "ok", count: edges.length, edges });
  });

  // ── Entity Resolution ────────────────────────────────────

  const EntityCreateSchema = z.object({
    name: z.string().min(1).max(200),
    type: z.string().max(50).default("unknown"),
    aliases: z.array(z.string().max(200)).default([]),
    metadata: z.record(z.string(), z.unknown()).default({}),
    user_id: z.string().max(100).default("default"),
  });

  const EntityRecallSchema = z.object({
    name: z.string().min(1).max(200),
    user_id: z.string().max(100).default("default"),
    limit: z.number().int().min(1).max(100).default(20),
  });

  const EntityMergeSchema = z.object({
    source_id: z.string().uuid(),
    target_id: z.string().uuid(),
  });

  app.post("/entities", async (c) => {
    const body = await parseAndValidate(c, EntityCreateSchema);
    const { upsertEntity } = await import("./entity.js");
    const id = await upsertEntity({
      name: body.name,
      type: body.type,
      aliases: body.aliases,
      metadata: body.metadata,
      userId: body.user_id,
    });
    return c.json({ status: "ok", id });
  });

  app.get("/entities", async (c) => {
    const { listEntities } = await import("./entity.js");
    const type = c.req.query("type") || undefined;
    const userId = c.req.query("user_id") || "default";
    const entities = await listEntities({ userId, type });
    return c.json({ status: "ok", count: entities.length, entities });
  });

  app.post("/entities/recall", async (c) => {
    const body = await parseAndValidate(c, EntityRecallSchema);
    const { recallByEntity } = await import("./entity.js");
    const result = await recallByEntity(body.name, {
      userId: body.user_id,
      limit: body.limit,
    });
    return c.json({ status: "ok", ...result });
  });

  app.post("/entities/merge", async (c) => {
    const body = await parseAndValidate(c, EntityMergeSchema);
    const { mergeEntities } = await import("./entity.js");
    await mergeEntities(body.source_id, body.target_id);
    return c.json({ status: "ok", message: "Entities merged" });
  });

  // ── Extraction Endpoints ─────────────────────────────────

  const ExtractPatternsSchema = z.object({
    message: z.string().min(1).max(5000),
    role: z.enum(["user", "assistant"]).default("user"),
  });

  app.post("/extract/patterns", async (c) => {
    const body = await parseAndValidate(c, ExtractPatternsSchema);
    const { extractPatterns } = await import("../extraction/patterns.js");
    const facts = extractPatterns(body.message, body.role);

    // Auto-store extracted facts
    for (const fact of facts) {
      await remember({
        type: fact.type,
        title: fact.title,
        content: fact.content,
        tags: fact.tags,
        importance: fact.confidence,
        source: "extraction",
      });
    }

    return c.json({ status: "ok", count: facts.length, facts });
  });

  const ExtractCorrectionSchema = z.object({
    user_message: z.string().min(1).max(5000),
    assistant_message: z.string().min(1).max(5000),
  });

  app.post("/extract/correction", async (c) => {
    const body = await parseAndValidate(c, ExtractCorrectionSchema);
    const { extractCorrection } = await import("../extraction/targeted.js");
    const result = await extractCorrection(body.user_message, body.assistant_message);

    // Auto-store extracted facts
    for (const fact of result.facts) {
      await remember({
        type: fact.type,
        title: fact.title,
        content: fact.content,
        tags: fact.tags,
        importance: fact.confidence,
        source: "extraction",
      });
    }

    return c.json({ status: "ok", count: result.facts.length, facts: result.facts, tokens_used: result.tokens_used });
  });

  const ExtractSummarizeSchema = z.object({
    messages: z.array(z.object({ role: z.string(), content: z.string() })).min(1),
    project: z.string().optional(),
  });

  app.post("/extract/summarize", async (c) => {
    const body = await parseAndValidate(c, ExtractSummarizeSchema);
    const { summarizeSession } = await import("../extraction/targeted.js");
    const result = await summarizeSession(body.messages, body.project);

    // Auto-store extracted facts
    for (const fact of result.facts) {
      await remember({
        type: fact.type,
        title: fact.title,
        content: fact.content,
        tags: fact.tags,
        importance: fact.confidence,
        source: "extraction",
        expiresIn: fact.type === "episode" ? "30d" : undefined,
      });
    }

    return c.json({ status: "ok", count: result.facts.length, facts: result.facts, tokens_used: result.tokens_used });
  });

  const ExtractPreferencesSchema = z.object({
    messages: z.array(z.object({ role: z.string(), content: z.string() })).min(1),
  });

  app.post("/extract/preferences", async (c) => {
    const body = await parseAndValidate(c, ExtractPreferencesSchema);
    const { extractPreferences } = await import("../extraction/targeted.js");
    const result = await extractPreferences(body.messages);

    for (const fact of result.facts) {
      await remember({
        type: fact.type,
        title: fact.title,
        content: fact.content,
        tags: fact.tags,
        importance: fact.confidence,
        source: "extraction",
      });
    }

    return c.json({ status: "ok", count: result.facts.length, facts: result.facts, tokens_used: result.tokens_used });
  });

  const ExtractFactsSchema = z.object({
    user_message: z.string().min(1).max(5000),
    assistant_message: z.string().max(5000).optional(),
    user_id: z.string().max(100).default("default"),
  });

  app.post("/extract/facts", async (c) => {
    const body = await parseAndValidate(c, ExtractFactsSchema);
    const { extractFacts } = await import("../extraction/targeted.js");
    const result = await extractFacts(body.user_message, body.assistant_message);

    // Store extracted facts
    const memoryIds: string[] = [];
    for (const fact of result.facts) {
      const id = await remember({
        type: fact.type,
        title: fact.title,
        content: fact.content,
        tags: fact.tags,
        importance: fact.confidence,
        source: "extraction",
        userId: body.user_id,
      });
      memoryIds.push(id);
    }

    // Store extracted entities and link to memories
    let entitiesStored = 0;
    if (result.entities?.length) {
      for (const entity of result.entities) {
        try {
          // Resolve or create entity
          const existing = await query<{ id: string }>(
            `SELECT id FROM entities WHERE (lower(canonical_name) = lower($1) OR lower($1) = ANY(SELECT lower(unnest(aliases))))
             AND (user_id = $2 OR user_id = 'default') LIMIT 1`,
            [entity.name, body.user_id]
          );

          let entityId: string;
          if (existing.rows.length > 0) {
            entityId = existing.rows[0].id;
            // Add as alias if not already present
            await query(
              `UPDATE entities SET aliases = array_append(aliases, $1), updated_at = now()
               WHERE id = $2 AND NOT ($1 = ANY(aliases)) AND lower(canonical_name) != lower($1)`,
              [entity.name, entityId]
            );
          } else {
            const created = await query<{ id: string }>(
              `INSERT INTO entities (canonical_name, entity_type, user_id) VALUES ($1, $2, $3) RETURNING id`,
              [entity.name, entity.type, body.user_id]
            );
            entityId = created.rows[0].id;
          }

          // Link entity to all memories created in this extraction
          for (const memId of memoryIds) {
            await query(
              `INSERT INTO memory_entities (memory_id, entity_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
              [memId, entityId]
            );
          }
          entitiesStored++;
        } catch { /* entity storage is best-effort */ }
      }
    }

    return c.json({
      status: "ok",
      count: result.facts.length,
      facts: result.facts,
      entities_stored: entitiesStored,
      tokens_used: result.tokens_used,
    });
  });

  // ── Metrics (Prometheus-compatible) ─────────────────────
  app.get("/metrics", async (c) => {
    const stats = await getStats();
    let dbLatency = -1;
    try {
      const start = Date.now();
      await query("SELECT 1");
      dbLatency = Date.now() - start;
    } catch { /* db down */ }

    const lines = [
      `# HELP shiba_memories_total Total number of memories stored`,
      `# TYPE shiba_memories_total gauge`,
      `shiba_memories_total ${stats.total_memories}`,
      `# HELP shiba_links_total Total number of memory links`,
      `# TYPE shiba_links_total gauge`,
      `shiba_links_total ${stats.total_links}`,
      `# HELP shiba_avg_confidence Average memory confidence`,
      `# TYPE shiba_avg_confidence gauge`,
      `shiba_avg_confidence ${stats.avg_confidence?.toFixed(3) || 0}`,
      `# HELP shiba_db_latency_ms Database round-trip latency in milliseconds`,
      `# TYPE shiba_db_latency_ms gauge`,
      `shiba_db_latency_ms ${dbLatency}`,
      `# HELP shiba_uptime_seconds Process uptime in seconds`,
      `# TYPE shiba_uptime_seconds gauge`,
      `shiba_uptime_seconds ${Math.floor(process.uptime())}`,
    ];
    return c.text(lines.join("\n") + "\n", 200, { "Content-Type": "text/plain; version=0.0.4" });
  });

  // ── OpenAPI Spec ────────────────────────────────────────
  app.get("/openapi.json", (c) => {
    return c.json({
      openapi: "3.1.0",
      info: {
        title: "Shiba Memory API",
        version: "0.2.0",
        description: "Persistent memory for AI agents with hybrid search, knowledge graphs, and self-improving memory.",
      },
      paths: {
        "/health": { get: { summary: "Health check (no auth)", tags: ["System"], responses: { "200": { description: "OK" } } } },
        "/status": { get: { summary: "Brain statistics", tags: ["System"], responses: { "200": { description: "OK" } } } },
        "/remember": { post: { summary: "Store a memory", tags: ["Memory"], requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/Remember" } } } }, responses: { "200": { description: "Memory stored" } } } },
        "/recall": { post: { summary: "Hybrid semantic + full-text search", tags: ["Memory"], requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/Recall" } } } }, responses: { "200": { description: "Search results" } } } },
        "/forget": { post: { summary: "Delete memories by criteria", tags: ["Memory"], requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/Forget" } } } }, responses: { "200": { description: "Deleted count" } } } },
        "/memory/{id}": {
          get: { summary: "Get memory by ID", tags: ["Memory"], parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }], responses: { "200": { description: "Memory" }, "404": { description: "Not found" } } },
          delete: { summary: "Delete memory by ID", tags: ["Memory"], parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }], responses: { "200": { description: "Deleted" } } },
        },
        "/link": { post: { summary: "Create relationship between memories", tags: ["Graph"], requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/Link" } } } }, responses: { "200": { description: "OK" } } } },
        "/links/{id}": { get: { summary: "Get relationships for a memory", tags: ["Graph"], parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }], responses: { "200": { description: "Links" } } } },
        "/link/auto": { post: { summary: "Auto-link all memories by similarity", tags: ["Graph"], responses: { "200": { description: "Links created count" } } } },
        "/reflect/consolidate": { post: { summary: "Full brain maintenance", tags: ["Maintenance"], responses: { "200": { description: "Consolidation results" } } } },
        "/reflect/decay": { post: { summary: "Decay old unused memories", tags: ["Maintenance"], responses: { "200": { description: "Decay results" } } } },
        "/event": { post: { summary: "Queue an event", tags: ["Events"], requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/Event" } } } }, responses: { "200": { description: "Queued" } } } },
        "/events": { get: { summary: "Get pending events", tags: ["Events"], responses: { "200": { description: "Event list" } } } },
        "/events/process": { post: { summary: "Mark events as processed", tags: ["Events"], requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/ProcessEvents" } } } }, responses: { "200": { description: "Processed" } } } },
        "/webhook": { post: { summary: "Generic webhook receiver", tags: ["Integration"], responses: { "200": { description: "Queued" } } } },
        "/channel": { post: { summary: "Channel message receiver", tags: ["Integration"], requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/Channel" } } } }, responses: { "200": { description: "Queued" } } } },
        "/metrics": { get: { summary: "Prometheus-compatible metrics", tags: ["System"], responses: { "200": { description: "Metrics text" } } } },
      },
      components: {
        schemas: {
          Remember: { type: "object", required: ["content"], properties: { type: { type: "string", enum: ["user","feedback","project","reference","episode","skill","instinct"] }, title: { type: "string", maxLength: 500 }, content: { type: "string", maxLength: 50000 }, tags: { type: "array", items: { type: "string" } }, importance: { type: "number", minimum: 0, maximum: 1 }, source: { type: "string" }, expires_in: { type: "string" }, profile: { type: "string" }, project_path: { type: "string" } } },
          Recall: { type: "object", required: ["query"], properties: { query: { type: "string", maxLength: 2000 }, type: { type: "string" }, tags: { type: "array", items: { type: "string" } }, limit: { type: "integer", minimum: 1, maximum: 100, default: 5 }, semantic_weight: { type: "number" }, fulltext_weight: { type: "number" }, profile: { type: "string" }, project: { type: "string" } } },
          Forget: { type: "object", properties: { id: { type: "string", format: "uuid" }, type: { type: "string" }, older_than: { type: "string" }, low_confidence: { type: "number" }, expired: { type: "boolean" } } },
          Link: { type: "object", required: ["source_id","target_id","relation"], properties: { source_id: { type: "string", format: "uuid" }, target_id: { type: "string", format: "uuid" }, relation: { type: "string", enum: ["related","supports","contradicts","supersedes","caused_by","derived_from"] }, strength: { type: "number", minimum: 0, maximum: 1, default: 0.5 } } },
          Event: { type: "object", properties: { source: { type: "string" }, event_type: { type: "string" }, payload: {} } },
          ProcessEvents: { type: "object", required: ["ids"], properties: { ids: { type: "array", items: { type: "integer" } } } },
          Channel: { type: "object", properties: { channel: { type: "string" }, sender: { type: "string" }, message: { type: "string" } } },
        },
        securitySchemes: {
          ApiKey: { type: "apiKey", in: "header", name: "X-Shiba-Key" },
        },
      },
      security: [{ ApiKey: [] }],
    });
  });

  // ── Error handler ───────────────────────────────────────
  app.onError((err, c) => {
    if (err instanceof ValidationError) {
      return c.json({
        status: "error",
        code: err.code,
        message: err.message,
        ...(err.errors ? { errors: err.errors } : {}),
      }, 400);
    }
    logger.error({ err: err.message, stack: err.stack, path: c.req.path, method: c.req.method }, "unhandled_error");
    // Don't leak internal error details to clients
    return c.json({ status: "error", code: "INTERNAL_ERROR", message: "An internal error occurred" }, 500);
  });

  app.notFound((c) => {
    return c.json({ status: "error", code: "NOT_FOUND", message: "Endpoint not found" }, 404);
  });

  return app;
}

// ── Server lifecycle (unchanged CLI interface) ──────────────

let serverInstance: Server | null = null;

export function startGateway(): void {
  if (existsSync(PID_FILE)) {
    const pid = parseInt(readFileSync(PID_FILE, "utf-8").trim());
    try {
      process.kill(pid, 0);
      console.log(JSON.stringify({ status: "error", message: `Gateway already running (PID ${pid})` }));
      return;
    } catch { /* stale pid */ }
  }

  // Startup health check: verify DB is reachable before binding the port
  query("SELECT 1").then(() => {
    logger.info("db_health_check_passed");
  }).catch((err) => {
    logger.error({ error: (err as Error).message }, "db_health_check_failed — gateway starting anyway, queries will fail until DB is available");
  });

  const app = createApp();

  serverInstance = serve({
    fetch: app.fetch,
    port: PORT,
    hostname: BIND_HOST,
  }, () => {
    writeFileSync(PID_FILE, String(process.pid));
    logger.info({ pid: process.pid, host: BIND_HOST, port: PORT, auth: !!API_KEY }, "gateway_started");
    console.log(JSON.stringify({
      status: "ok",
      message: "Shiba Gateway started",
      pid: process.pid,
      host: BIND_HOST,
      port: PORT,
      auth: API_KEY ? "enabled" : "disabled (set SHB_API_KEY to secure)",
      features: ["zod-validation", "rate-limiting", "body-size-limits", "structured-logging", "prometheus-metrics"],
      endpoints: [
        "GET  /health",
        "GET  /status",
        "POST /remember",
        "POST /recall",
        "POST /forget",
        "GET  /memory/:id",
        "DELETE /memory/:id",
        "POST /link",
        "GET  /links/:id",
        "POST /link/auto",
        "POST /reflect/consolidate",
        "POST /reflect/decay",
        "POST /event",
        "GET  /events",
        "POST /events/process",
        "POST /webhook",
        "POST /channel",
        "GET  /metrics",
      ],
    }));
  }) as Server;

  const shutdown = () => {
    try { unlinkSync(PID_FILE); } catch { /* ignore */ }
    if (serverInstance) serverInstance.close();
    disconnect().then(() => process.exit(0));
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

export function stopGateway(): { stopped: boolean; pid?: number } {
  if (!existsSync(PID_FILE)) return { stopped: false };

  const pid = parseInt(readFileSync(PID_FILE, "utf-8").trim());
  try {
    process.kill(pid, "SIGTERM");
    unlinkSync(PID_FILE);
    return { stopped: true, pid };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ESRCH") {
      try { unlinkSync(PID_FILE); } catch { /* ignore */ }
      return { stopped: false };
    }
    throw e;
  }
}

export function gatewayStatus(): { running: boolean; pid?: number; port: number } {
  if (!existsSync(PID_FILE)) return { running: false, port: PORT };

  const pid = parseInt(readFileSync(PID_FILE, "utf-8").trim());
  try {
    process.kill(pid, 0);
    return { running: true, pid, port: PORT };
  } catch {
    try { unlinkSync(PID_FILE); } catch { /* ignore */ }
    return { running: false, port: PORT };
  }
}

// Export app factory for testing
export { createApp };
