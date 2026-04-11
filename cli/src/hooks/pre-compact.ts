#!/usr/bin/env node
/**
 * Claude Code Hook: PreCompact
 *
 * Fires before Claude Code compresses the conversation context.
 * This is our chance to extract important context that would otherwise be lost
 * during compaction and store it as memories.
 *
 * stdin JSON schema (from Claude Code):
 * {
 *   "session_id": "...",
 *   "message_count": number,
 *   "token_count": number
 * }
 */

import {
  safeRun,
  getHookEnv,
  parseStdinJson,
  remember,
  queryDB,
  detectProject,
  detectProjectPath,
} from "./common.js";

interface PreCompactEvent {
  session_id?: string;
  message_count?: number;
  token_count?: number;
}

safeRun(async () => {
  const event = await parseStdinJson<PreCompactEvent>();
  const env = getHookEnv();
  const projectName = detectProject(env.projectDir);
  const projectPath = detectProjectPath(env.projectDir);
  const sessionId = event?.session_id || env.sessionId;

  // Fetch current conversation state
  // NOTE: column is key_decisions (not "decisions") — was causing silent data loss.
  const conv = await queryDB<{
    summary: string | null;
    key_decisions: unknown[] | null;
    files_touched: string[] | null;
  }>(
    `SELECT summary, key_decisions, files_touched
     FROM conversations
     WHERE session_id = $1`,
    [sessionId]
  );

  if (!conv.rows[0]) return;

  const { summary, key_decisions: decisions, files_touched } = conv.rows[0];

  // If we have accumulated decisions, store them as a session snapshot
  if (decisions && decisions.length > 0) {
    const decisionText = (decisions as string[])
      .map((d) => {
        try {
          const parsed = JSON.parse(d);
          return JSON.stringify(parsed);
        } catch {
          return d;
        }
      })
      .join("\n");

    await remember({
      type: "episode",
      title: `Session snapshot before compaction — ${projectName}`,
      content: [
        `Project: ${projectName}`,
        `Session: ${sessionId}`,
        summary ? `Summary: ${summary}` : null,
        files_touched?.length ? `Files touched: ${files_touched.join(", ")}` : null,
        `Decisions/Events:\n${decisionText}`,
      ]
        .filter(Boolean)
        .join("\n"),
      tags: ["pre-compact", "session-snapshot"],
      importance: 0.5,
      source: "hook",
      expiresIn: "14d",
      profile: "project",
      projectPath,
    });
  }
});
