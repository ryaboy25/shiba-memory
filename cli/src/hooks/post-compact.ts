#!/usr/bin/env node
/**
 * Claude Code Hook: PostCompact
 *
 * Fires after Claude Code compresses the conversation context.
 * Re-injects the most relevant memories for the current project so the
 * compressed context still has key information available.
 *
 * stdin JSON schema (from Claude Code):
 * {
 *   "session_id": "...",
 *   "message_count_before": number,
 *   "message_count_after": number,
 *   "token_count_before": number,
 *   "token_count_after": number
 * }
 */

import {
  safeRun,
  getHookEnv,
  recall,
  detectProject,
  detectProjectPath,
} from "./common.js";

safeRun(async () => {
  const env = getHookEnv();
  const projectName = detectProject(env.projectDir);
  const projectPath = detectProjectPath(env.projectDir);

  // After compaction, re-inject key context so Claude doesn't lose important info
  const memories = await recall({
    query: `${projectName} current work context decisions`,
    project: projectPath,
    limit: 5,
    skipTouch: true,
  });

  const feedback = await recall({
    query: "user preferences coding style feedback",
    type: "feedback",
    limit: 3,
    skipTouch: true,
  });

  const all = [...memories, ...feedback];
  if (all.length === 0) return;

  // Deduplicate
  const seen = new Set<string>();
  const unique = all.filter((m) => {
    if (seen.has(m.id)) return false;
    seen.add(m.id);
    return true;
  });

  const lines = unique.map(
    (m) => `[${m.type}] ${m.title}: ${m.content.slice(0, 200)}`
  );

  console.log(
    `<shiba-context project="${projectName}" reason="post-compact">\n${lines.join("\n")}\n</shiba-context>`
  );
});
