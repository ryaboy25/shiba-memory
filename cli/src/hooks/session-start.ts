#!/usr/bin/env node
/**
 * Claude Code Hook: SessionStart
 *
 * Fires when a new Claude Code session begins.
 * Recalls relevant memories for the current project and injects them into
 * the session context via stdout (Claude Code reads hook stdout).
 */

import {
  safeRun,
  getHookEnv,
  recall,
  detectProject,
  detectProjectPath,
  query,
} from "./common.js";

safeRun(async () => {
  const env = getHookEnv();
  const projectName = detectProject(env.projectDir);
  const projectPath = detectProjectPath(env.projectDir);

  // 1. Recall project-scoped memories (most relevant to current work)
  const projectMemories = await recall({
    query: `${projectName} project context`,
    project: projectPath,
    limit: 5,
    skipTouch: true,
  });

  // 2. Recall user preferences and feedback (global)
  const userMemories = await recall({
    query: "user preferences and feedback",
    type: "user",
    limit: 3,
    skipTouch: true,
  });

  const feedbackMemories = await recall({
    query: "coding feedback and corrections",
    type: "feedback",
    limit: 3,
    skipTouch: true,
  });

  // 3. Recall relevant skills
  const skills = await recall({
    query: `${projectName} coding patterns skills`,
    type: "skill",
    limit: 3,
    skipTouch: true,
  });

  // 4. Log the session start
  await query(
    `INSERT INTO conversations (session_id, summary, project_path)
     VALUES ($1, $2, $3)
     ON CONFLICT (session_id) DO UPDATE SET summary = conversations.summary`,
    [env.sessionId, `Session started for ${projectName}`, projectPath]
  );

  // Build context block for Claude Code
  const allMemories = [
    ...projectMemories,
    ...userMemories,
    ...feedbackMemories,
    ...skills,
  ];

  if (allMemories.length === 0) return;

  // Deduplicate by ID
  const seen = new Set<string>();
  const unique = allMemories.filter((m) => {
    if (seen.has(m.id)) return false;
    seen.add(m.id);
    return true;
  });

  // Output as structured context that Claude Code can consume
  const lines = unique.map(
    (m) => `[${m.type}] ${m.title}: ${m.content.slice(0, 200)}`
  );

  console.log(
    `<shiba-context project="${projectName}">\n${lines.join("\n")}\n</shiba-context>`
  );
});
