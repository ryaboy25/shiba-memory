#!/usr/bin/env node
/**
 * Claude Code Hook: Stop
 *
 * Fires when Claude Code finishes a response.
 * - Updates conversation record with token usage
 * - Tier 2: Summarizes session via LLM (if available and enough messages)
 * - Regenerates .shiba/ files for next session
 * - Cleans up old episodes
 */

import {
  safeRun,
  getHookEnv,
  parseStdinJson,
  queryDB,
  remember,
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
  await queryDB(
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
        tokens: { input: event?.input_tokens, output: event?.output_tokens },
        timestamp: new Date().toISOString(),
      }),
      sessionId,
    ]
  );

  // ── Tier 2: Session summarization (if LLM available + enough messages) ──
  if ((event?.message_count || 0) >= 4) {
    try {
      const { isLLMAvailable } = await import("../llm.js");
      if (isLLMAvailable()) {
        // Fetch recent episodes for this session to summarize
        const episodes = await queryDB<{ content: string }>(
          `SELECT content FROM memories
           WHERE type = 'episode'
             AND tags @> ARRAY['session-event']
             AND project_path = $1
           ORDER BY created_at DESC
           LIMIT 10`,
          [projectPath]
        );

        if (episodes.rows.length >= 3) {
          const { summarizeSession } = await import("../extraction/targeted.js");
          const messages = episodes.rows.map((r) => ({
            role: "assistant" as const,
            content: r.content,
          }));

          const result = await summarizeSession(messages, projectName);
          for (const fact of result.facts) {
            await remember({
              type: fact.type,
              title: fact.title,
              content: fact.content,
              tags: [...fact.tags, projectName],
              importance: fact.confidence,
              source: "hook",
              expiresIn: fact.type === "episode" ? "30d" : undefined,
              profile: "project",
              projectPath,
            });
          }
        }
      }
    } catch {
      // Summarization is optional
    }
  }

  // ── Regenerate .shiba/ files ──
  try {
    const { materialize } = await import("../commands/materialize.js");
    await materialize({ projectPath, outputDir: env.projectDir });
  } catch {
    // Best-effort
  }

  // Clean up old session episodes (keep last 50 per project)
  await queryDB(
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
