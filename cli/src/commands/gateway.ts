import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "fs";
import { timingSafeEqual } from "crypto";
import { query, disconnect } from "../db.js";
import { embed, pgVector } from "../embeddings.js";
import { remember } from "./remember.js";
import { recall } from "./recall.js";
import { forget } from "./forget.js";
import { linkMemories, getRelated, autoLinkAll } from "./link.js";
import { getStats, decayMemories, consolidate } from "./reflect.js";

const PORT = parseInt(process.env.SHB_GATEWAY_PORT || "18789");
const BIND_HOST = process.env.SHB_GATEWAY_HOST || "0.0.0.0";
const API_KEY = process.env.SHB_API_KEY || "";
const PID_FILE = "/tmp/shiba-gateway.pid";
const MAX_BODY_BYTES = parseInt(process.env.SHB_MAX_BODY_BYTES || "1048576"); // 1MB default
const CORS_ORIGIN = process.env.SHB_CORS_ORIGIN || "*";

function parseBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    let data = "";
    let bytes = 0;
    let aborted = false;
    req.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        aborted = true;
        req.destroy();
        resolve(null); // null signals 413
        return;
      }
      data += chunk;
    });
    req.on("end", () => {
      if (aborted) return;
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
  });
}

function respond(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

/** Parse body with size limit. Returns null and sends 413 if too large. */
async function safeParseBody(req: IncomingMessage, res: ServerResponse): Promise<Record<string, unknown> | null> {
  const body = await parseBody(req);
  if (body === null) {
    respond(res, 413, { status: "error", message: "Payload too large" });
    return null;
  }
  return body;
}

function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // Compare against matching-length buffer to avoid timing leak on length
    timingSafeEqual(bufA, Buffer.alloc(bufA.length));
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

function authenticate(req: IncomingMessage, res: ServerResponse): boolean {
  if (!API_KEY) return true; // No key configured = open access
  const provided = req.headers["x-shiba-key"] as string
    || req.headers["x-shb-key"] as string
    || req.headers["authorization"]?.replace("Bearer ", "");
  if (provided && safeCompare(provided, API_KEY)) return true;
  respond(res, 401, { status: "error", message: "Unauthorized — set X-Shiba-Key header" });
  return false;
}

export function startGateway(): void {
  if (existsSync(PID_FILE)) {
    const pid = parseInt(readFileSync(PID_FILE, "utf-8").trim());
    try {
      process.kill(pid, 0);
      console.log(JSON.stringify({ status: "error", message: `Gateway already running (PID ${pid})` }));
      return;
    } catch { /* stale pid */ }
  }

  const server = createServer(async (req, res) => {
    // CORS
    res.setHeader("Access-Control-Allow-Origin", CORS_ORIGIN);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Shiba-Key, X-SHB-Key, Authorization");
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

    // GET /health — lightweight, no auth required
    if (req.url === "/health" && req.method === "GET") {
      respond(res, 200, { status: "ok", uptime_seconds: Math.floor(process.uptime()) });
      return;
    }

    // Auth check for all other endpoints
    if (!authenticate(req, res)) return;

    const url = req.url || "/";

    try {
      // GET /status
      if (url === "/status" && req.method === "GET") {
        const stats = await getStats();
        const events = await query<{ count: string }>(
          `SELECT COUNT(*)::TEXT as count FROM events_queue WHERE NOT processed`
        );
        respond(res, 200, {
          status: "ok",
          brain: stats,
          pending_events: parseInt(events.rows[0].count),
          uptime_seconds: Math.floor(process.uptime()),
        });
        return;
      }

      // POST /remember
      if (url === "/remember" && req.method === "POST") {
        const body = await safeParseBody(req, res);
        if (!body) return;
        const id = await remember({
          type: (body.type as string) || "reference",
          title: (body.title as string) || "Gateway memory",
          content: (body.content as string) || "",
          tags: (body.tags as string[]) || ["gateway"],
          importance: (body.importance as number) || 0.5,
          source: (body.source as string) || "gateway",
          expiresIn: body.expires_in as string | undefined,
          profile: (body.profile as string) || undefined,
          projectPath: body.project_path as string | undefined,
        });
        respond(res, 200, { status: "ok", id });
        return;
      }

      // POST /recall
      if (url === "/recall" && req.method === "POST") {
        const body = await safeParseBody(req, res); if (!body) return;
        const results = await recall({
          query: (body.query as string) || "",
          type: body.type as string | undefined,
          tags: body.tags as string[] | undefined,
          limit: (body.limit as number) || 5,
          semanticWeight: body.semantic_weight as number | undefined,
          fulltextWeight: body.fulltext_weight as number | undefined,
          profile: body.profile as string | undefined,
          project: body.project as string | undefined,
        });
        respond(res, 200, { status: "ok", count: results.length, memories: results });
        return;
      }

      // POST /forget
      if (url === "/forget" && req.method === "POST") {
        const body = await safeParseBody(req, res); if (!body) return;
        const count = await forget({
          id: body.id as string | undefined,
          type: body.type as string | undefined,
          olderThan: body.older_than as string | undefined,
          lowConfidence: body.low_confidence as number | undefined,
          expired: body.expired as boolean | undefined,
        });
        respond(res, 200, { status: "ok", deleted: count });
        return;
      }

      // DELETE /memory/:id
      if (url.startsWith("/memory/") && req.method === "DELETE") {
        const id = url.slice("/memory/".length);
        const count = await forget({ id });
        respond(res, 200, { status: "ok", deleted: count });
        return;
      }

      // GET /memory/:id
      if (url.startsWith("/memory/") && req.method === "GET") {
        const id = url.slice("/memory/".length);
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
          respond(res, 404, { status: "error", message: "Memory not found" });
        } else {
          await query(`SELECT touch_memory($1)`, [id]);
          respond(res, 200, { status: "ok", memory: result.rows[0] });
        }
        return;
      }

      // POST /link
      if (url === "/link" && req.method === "POST") {
        const body = await safeParseBody(req, res); if (!body) return;
        const sourceId = body.source_id as string;
        const targetId = body.target_id as string;
        const relation = body.relation as string;
        const strength = (body.strength as number) || 0.5;
        if (!sourceId || !targetId || !relation) {
          respond(res, 400, { status: "error", message: "source_id, target_id, and relation are required" });
          return;
        }
        await linkMemories(sourceId, targetId, relation, strength);
        respond(res, 200, { status: "ok" });
        return;
      }

      // GET /links/:id
      if (url.startsWith("/links/") && req.method === "GET") {
        const id = url.slice("/links/".length);
        const links = await getRelated(id);
        respond(res, 200, { status: "ok", links });
        return;
      }

      // POST /link/auto
      if (url === "/link/auto" && req.method === "POST") {
        const count = await autoLinkAll();
        respond(res, 200, { status: "ok", links_created: count });
        return;
      }

      // POST /reflect/consolidate
      if (url === "/reflect/consolidate" && req.method === "POST") {
        const result = await consolidate();
        respond(res, 200, { status: "ok", ...result });
        return;
      }

      // POST /reflect/decay
      if (url === "/reflect/decay" && req.method === "POST") {
        const result = await decayMemories();
        respond(res, 200, { status: "ok", ...result });
        return;
      }

      // POST /event
      if (url === "/event" && req.method === "POST") {
        const body = await safeParseBody(req, res); if (!body) return;
        await query(
          `INSERT INTO events_queue (source, event_type, payload)
           VALUES ($1, $2, $3::jsonb)`,
          [
            (body.source as string) || "gateway",
            (body.event_type as string) || "message",
            JSON.stringify(body.payload || body),
          ]
        );
        respond(res, 200, { status: "ok", queued: true });
        return;
      }

      // GET /events
      if (url === "/events" && req.method === "GET") {
        const events = await query<{
          id: number;
          source: string;
          event_type: string;
          payload: unknown;
          created_at: string;
        }>(
          `SELECT id, source, event_type, payload, created_at
           FROM events_queue WHERE NOT processed
           ORDER BY created_at ASC LIMIT 50`
        );
        respond(res, 200, { status: "ok", events: events.rows });
        return;
      }

      // POST /events/process
      if (url === "/events/process" && req.method === "POST") {
        const body = await safeParseBody(req, res); if (!body) return;
        const ids = body.ids as number[];
        if (ids && ids.length > 0) {
          await query(
            `UPDATE events_queue SET processed = true, processed_at = now()
             WHERE id = ANY($1::bigint[])`,
            [ids]
          );
        }
        respond(res, 200, { status: "ok", processed: ids?.length || 0 });
        return;
      }

      // POST /webhook — Generic webhook receiver for external integrations
      if (url === "/webhook" && req.method === "POST") {
        const body = await safeParseBody(req, res); if (!body) return;
        const source = (body.source as string)
          || req.headers["x-webhook-source"] as string
          || "webhook";
        const eventType = (body.event_type as string)
          || (body.type as string)
          || "webhook";

        await query(
          `INSERT INTO events_queue (source, event_type, payload)
           VALUES ($1, $2, $3::jsonb)`,
          [source, eventType, JSON.stringify(body)]
        );

        // Also store as a memory if it looks important
        const message = (body.message as string)
          || (body.text as string)
          || (body.content as string);

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

        respond(res, 200, { status: "ok", queued: true, source, event_type: eventType });
        return;
      }

      // POST /channel — Receives messages from external integrations
      if (url === "/channel" && req.method === "POST") {
        const body = await safeParseBody(req, res); if (!body) return;
        const channel = (body.channel as string) || "unknown";
        const sender = (body.sender as string) || "unknown";
        const message = (body.message as string) || JSON.stringify(body);

        // Queue as event
        await query(
          `INSERT INTO events_queue (source, event_type, payload)
           VALUES ($1, 'channel_message', $2::jsonb)`,
          [`channel:${channel}`, JSON.stringify({ channel, sender, message })]
        );

        // Store as episode memory
        await remember({
          type: "episode",
          title: `Channel message from ${sender} via ${channel}`,
          content: message.slice(0, 2000),
          tags: ["channel", channel, sender],
          importance: 0.6,
          source: "gateway",
          expiresIn: "30d",
        });

        respond(res, 200, { status: "ok", channel, sender, queued: true });
        return;
      }

      respond(res, 404, { status: "error", message: "Not found" });
    } catch (e) {
      respond(res, 500, { status: "error", message: (e as Error).message });
    }
  });

  server.listen(PORT, BIND_HOST, () => {
    writeFileSync(PID_FILE, String(process.pid));
    console.log(JSON.stringify({
      status: "ok",
      message: "Shiba Gateway started",
      pid: process.pid,
      host: BIND_HOST,
      port: PORT,
      auth: API_KEY ? "enabled" : "disabled (set SHB_API_KEY to secure)",
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
      ],
    }));
  });

  const shutdown = () => {
    try { unlinkSync(PID_FILE); } catch { /* ignore */ }
    server.close();
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
