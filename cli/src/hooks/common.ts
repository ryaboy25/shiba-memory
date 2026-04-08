/**
 * Shared utilities for Claude Code hooks.
 *
 * Claude Code hooks receive context via:
 *  - Environment variables: CLAUDE_SESSION_ID, CLAUDE_PROJECT_DIR, CLAUDE_MODEL, etc.
 *  - stdin (JSON): varies by hook type
 *
 * Hooks must exit quickly (timeout is 5s by default) so we avoid heavy operations
 * and use skipTouch on recalls to reduce DB round-trips.
 */

import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import dotenv from "dotenv";

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, "../../../.env") });

export { query, disconnect } from "../db.js";
export { embed, pgVector } from "../embeddings.js";
export { recall } from "../commands/recall.js";
export { remember } from "../commands/remember.js";
export { detectProject, detectProjectPath } from "../utils/project.js";

export function getHookEnv() {
  return {
    sessionId: process.env.CLAUDE_SESSION_ID || `session-${Date.now()}`,
    projectDir: process.env.CLAUDE_PROJECT_DIR || process.cwd(),
    model: process.env.CLAUDE_MODEL || "unknown",
  };
}

export async function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    // If stdin is a TTY or nothing is piped, resolve immediately
    if (process.stdin.isTTY) resolve("");
    setTimeout(() => resolve(data), 500); // safety timeout
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
    // Non-blocking: log to stderr but exit 0 so Claude Code isn't disrupted
    console.error(`[shiba-hook] ${(e as Error).message}`);
  } finally {
    const { disconnect: dc } = await import("../db.js");
    await dc();
  }
}
