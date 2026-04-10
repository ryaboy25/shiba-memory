/**
 * Shared utilities for Claude Code hooks.
 *
 * Claude Code hooks receive context via:
 *  - Environment variables: CLAUDE_SESSION_ID, CLAUDE_PROJECT_DIR, CLAUDE_MODEL, etc.
 *  - stdin (JSON): varies by hook type
 *
 * Hooks prefer the gateway API (single HTTP request) over direct DB access
 * (which spawns a pool per invocation). Falls back to direct DB if gateway
 * is unreachable.
 */

import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import dotenv from "dotenv";

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, "../../../.env") });

export { detectProject, detectProjectPath } from "../utils/project.js";

const GATEWAY_URL = `http://${process.env.SHB_GATEWAY_HOST || "localhost"}:${process.env.SHB_GATEWAY_PORT || "18789"}`;
const API_KEY = process.env.SHB_API_KEY || "";

// ── Gateway API client ──────────────────────────────────────

let gatewayAvailable: boolean | null = null;

async function gatewayFetch(path: string, body?: unknown): Promise<unknown> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (API_KEY) headers["X-Shiba-Key"] = API_KEY;

  const res = await fetch(`${GATEWAY_URL}${path}`, {
    method: body ? "POST" : "GET",
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(4000), // 4s timeout (hook limit is 5s)
  });

  if (!res.ok) throw new Error(`Gateway ${path}: ${res.status}`);
  return res.json();
}

async function isGatewayUp(): Promise<boolean> {
  if (gatewayAvailable !== null) return gatewayAvailable;
  try {
    await fetch(`${GATEWAY_URL}/health`, { signal: AbortSignal.timeout(1000) });
    gatewayAvailable = true;
  } catch {
    gatewayAvailable = false;
  }
  return gatewayAvailable;
}

// ── Public API (gateway-first, DB fallback) ─────────────────

export interface RecallResult {
  id: string;
  type: string;
  title: string;
  content: string;
  relevance: number;
  tags: string[];
  created_at?: string;
}

export async function recall(opts: {
  query: string;
  type?: string;
  limit?: number;
  project?: string;
  skipTouch?: boolean;
}): Promise<RecallResult[]> {
  if (await isGatewayUp()) {
    const result = await gatewayFetch("/recall", {
      query: opts.query,
      type: opts.type,
      limit: opts.limit || 5,
      project: opts.project,
    }) as { memories: RecallResult[] };
    return result.memories || [];
  }
  // Fallback to direct DB
  const { recall: dbRecall } = await import("../commands/recall.js");
  return dbRecall(opts);
}

export async function remember(opts: {
  type: string;
  title: string;
  content: string;
  tags?: string[];
  importance?: number;
  source?: string;
  expiresIn?: string;
  profile?: string;
  projectPath?: string;
}): Promise<string> {
  if (await isGatewayUp()) {
    const result = await gatewayFetch("/remember", {
      type: opts.type,
      title: opts.title,
      content: opts.content,
      tags: opts.tags,
      importance: opts.importance,
      source: opts.source,
      expires_in: opts.expiresIn,
      profile: opts.profile,
      project_path: opts.projectPath,
    }) as { id: string };
    return result.id || "stored";
  }
  // Fallback to direct DB
  const { remember: dbRemember } = await import("../commands/remember.js");
  return dbRemember(opts);
}

export async function queryDB<T extends Record<string, unknown> = Record<string, unknown>>(text: string, params?: unknown[]) {
  // Raw queries always use direct DB (gateway doesn't expose raw SQL)
  const { query } = await import("../db.js");
  return query<T & import("pg").QueryResultRow>(text, params);
}

// ── Hook environment ────────────────────────────────────────

export function getHookEnv() {
  return {
    sessionId: process.env.CLAUDE_SESSION_ID || `session-${Date.now()}`,
    projectDir: process.env.CLAUDE_PROJECT_DIR || process.cwd(),
    model: process.env.CLAUDE_MODEL || "unknown",
  };
}

export async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";

  return new Promise((resolve) => {
    let data = "";
    let resolved = false;

    const done = () => {
      if (resolved) return;
      resolved = true;
      resolve(data);
    };

    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", done);
    process.stdin.on("error", done);

    // Safety timeout — hooks have a 5s limit, give stdin 2s max
    setTimeout(done, 2000);
  });
}

export async function parseStdinJson<T = unknown>(): Promise<T | null> {
  const raw = await readStdin();
  if (!raw.trim()) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** Safe wrapper — runs fn, catches errors silently (hooks must not break Claude Code) */
export async function safeRun(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    console.error(`[shiba-hook] ${(e as Error).message}`);
  } finally {
    // Only disconnect if we used direct DB (gateway mode doesn't need it)
    if (!gatewayAvailable) {
      try {
        const { disconnect } = await import("../db.js");
        await disconnect();
      } catch { /* ignore */ }
    }
  }
}
