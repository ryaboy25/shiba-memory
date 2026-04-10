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
  queryDB,
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
  await queryDB(
    `INSERT INTO conversations (session_id, summary, project_path)
     VALUES ($1, $2, $3)
     ON CONFLICT (session_id) DO UPDATE SET summary = conversations.summary`,
    [env.sessionId, `Session started for ${projectName}`, projectPath]
  );

  // Materialize .shiba/ files for the project
  try {
    const { materialize } = await import("../commands/materialize.js");
    await materialize({ projectPath, outputDir: env.projectDir });
  } catch {
    // Materialization is best-effort — don't fail the hook
  }

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

  // Output as structured context with timestamps for temporal reasoning
  const lines = unique.map((m) => {
    const date = m.created_at ? ` (${new Date(m.created_at).toLocaleDateString()})` : "";
    return `[${m.type}]${date} ${m.title}: ${m.content.slice(0, 200)}`;
  });

  // Escape XML special chars in project name to prevent injection
  const safeProject = projectName.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  console.log(
    `<shiba-context project="${safeProject}">\n${lines.join("\n")}\n</shiba-context>`
  );
});
