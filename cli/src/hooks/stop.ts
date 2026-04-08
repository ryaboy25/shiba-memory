#!/usr/bin/env node
/**
 * Claude Code Hook: Stop
 *
 * Fires when Claude Code finishes a response.
 * Captures session summary and stores any instincts (low-confidence observations)
 * that may later evolve into skills.
 *
 * stdin JSON schema (from Claude Code):
 * {
 *   "session_id": "...",
 *   "stop_reason": "end_turn" | "max_tokens" | "stop_sequence",
 *   "message_count": number,
 *   "input_tokens": number,
 *   "output_tokens": number
 * }
 */

import {
  safeRun,
  getHookEnv,
  parseStdinJson,
  query,
  detectProject,
  detectProjectPath,
} from "./common.js";

interface StopEvent {
  session_id?: string;
  stop_reason?: string;
  message_count?: number;
  input_tokens?: number;
  output_tokens?: number;
}

safeRun(async () => {
  const event = await parseStdinJson<StopEvent>();
  const env = getHookEnv();
  const projectName = detectProject(env.projectDir);
  const projectPath = detectProjectPath(env.projectDir);
  const sessionId = event?.session_id || env.sessionId;

  // Update conversation record with token usage
  await query(
    `UPDATE conversations
     SET summary = COALESCE(summary, '') || $1,
         decisions = array_append(
           COALESCE(decisions, '{}'),
           $2
         )
     WHERE session_id = $3`,
    [
      `\n[Stop] ${event?.stop_reason || "end_turn"} — ${event?.message_count || 0} messages`,
      JSON.stringify({
        stop_reason: event?.stop_reason,
        tokens: {
          input: event?.input_tokens,
          output: event?.output_tokens,
        },
        timestamp: new Date().toISOString(),
      }),
      sessionId,
    ]
  );

  // Clean up old session episodes (keep last 50 per project)
  await query(
    `DELETE FROM memories
     WHERE id IN (
       SELECT id FROM memories
       WHERE type = 'episode'
         AND tags @> ARRAY['session-event']
         AND project_path = $1
       ORDER BY created_at DESC
       OFFSET 50
     )`,
    [projectPath]
  );
});
