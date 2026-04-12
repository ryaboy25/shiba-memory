#!/usr/bin/env node
/**
 * Claude Code Hook: PostToolUse
 *
 * Fires after Edit, Write, or Bash tool calls.
 * - Tier 1: Captures tool events as episodic memories
 * - Tier 1: Pattern-matches user messages for facts
 * - Tier 2: Detects corrections and extracts what changed (if LLM available)
 */

import {
  safeRun,
  getHookEnv,
  parseStdinJson,
  remember,
  detectProject,
  detectProjectPath,
  queryDB,
} from "./common.js";

interface ToolEvent {
  session_id?: string;
  tool_name?: string;
  tool_input?: {
    file_path?: string;
    command?: string;
    content?: string;
    old_string?: string;
    new_string?: string;
  };
  tool_output?: string;
  // Extended: user message context (if available from Claude Code)
  user_message?: string;
  assistant_message?: string;
}

safeRun(async () => {
  const event = await parseStdinJson<ToolEvent>();
  if (!event?.tool_name) return;

  const env = getHookEnv();
  const projectName = detectProject(env.projectDir);
  const projectPath = detectProjectPath(env.projectDir);

  // ── Tier 1: Pattern extraction from user message ──────────
  if (event.user_message) {
    try {
      const { extractPatterns, isCorrection } = await import("../extraction/patterns.js");
      const facts = extractPatterns(event.user_message, "user");

      for (const fact of facts) {
        await remember({
          type: fact.type,
          title: fact.title,
          content: fact.content,
          tags: [...fact.tags, projectName],
          importance: fact.confidence,
          source: "hook",
          profile: fact.type === "project" ? "project" : "global",
          projectPath: fact.type === "project" ? projectPath : undefined,
        });
      }

      // ── Tier 2: Correction extraction (if LLM available) ─────
      if (isCorrection(event.user_message) && event.assistant_message) {
        try {
          const { extractCorrection } = await import("../extraction/targeted.js");
          const result = await extractCorrection(event.user_message, event.assistant_message);
          for (const fact of result.facts) {
            await remember({
              type: fact.type,
              title: fact.title,
              content: fact.content,
              tags: [...fact.tags, projectName],
              importance: fact.confidence,
              source: "hook",
            });
          }
        } catch {
          // Tier 2 is optional — LLM may not be configured
        }
      }

      // ── Tier 2: Fact + Entity extraction (if LLM available) ─────
      if (event.user_message && event.user_message.length >= 20) {
        try {
          const { extractFacts } = await import("../extraction/targeted.js");
          const { isLLMAvailable } = await import("../llm.js");
          if (isLLMAvailable()) {
            const result = await extractFacts(event.user_message, event.assistant_message);
            const memoryIds: string[] = [];
            for (const fact of result.facts) {
              const id = await remember({
                type: fact.type,
                title: fact.title,
                content: fact.content,
                tags: [...fact.tags, projectName],
                importance: fact.confidence,
                source: "hook",
              });
              if (id && id !== "stored") memoryIds.push(id);
            }
            // Store entities and link to extracted memories
            if (result.entities?.length) {
              for (const entity of result.entities) {
                try {
                  const resolved = await queryDB<{ id: string }>(
                    `SELECT resolve_entity($1, $2) AS id`,
                    [entity.name, null]
                  );
                  const entityId = resolved.rows[0]?.id;
                  if (entityId) {
                    // Update entity type if we have one
                    await queryDB(
                      `UPDATE entities SET entity_type = COALESCE(entity_type, $1) WHERE id = $2`,
                      [entity.type, entityId]
                    );
                    // Link entity to all memories from this extraction
                    for (const memId of memoryIds) {
                      await queryDB(
                        `INSERT INTO memory_entities (memory_id, entity_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
                        [memId, entityId]
                      );
                    }
                  }
                } catch { /* entity storage is best-effort */ }
              }
            }
          }
        } catch {
          // Fact extraction is optional
        }
      }
    } catch {
      // Pattern extraction failure is non-critical
    }
  }

  // ── Tier 1: Tool event capture ────────────────────────────
  let title = "";
  let content = "";
  const tags = ["session-event", `tool-${event.tool_name.toLowerCase()}`];

  switch (event.tool_name) {
    case "Edit": {
      const filePath = event.tool_input?.file_path || "unknown file";
      const fileName = filePath.split("/").pop() || filePath;
      title = `Edited ${fileName}`;
      content = `File: ${filePath}`;
      if (event.tool_input?.old_string && event.tool_input?.new_string) {
        const oldSnip = event.tool_input.old_string.slice(0, 100);
        const newSnip = event.tool_input.new_string.slice(0, 100);
        content += `\nChanged: "${oldSnip}" → "${newSnip}"`;
      }
      break;
    }
    case "Write": {
      const filePath = event.tool_input?.file_path || "unknown file";
      const fileName = filePath.split("/").pop() || filePath;
      title = `Created/wrote ${fileName}`;
      content = `File: ${filePath}`;
      if (event.tool_input?.content) {
        content += `\nContent preview: ${event.tool_input.content.slice(0, 150)}`;
      }
      break;
    }
    case "Bash": {
      const cmd = event.tool_input?.command || "";
      // Skip read-only / navigational commands (including with flags)
      if (/^(ls|cat|head|tail|echo|pwd|cd|which|type|file|wc|du|df|whoami|date|env|printenv)(\s|$)/.test(cmd)) return;
      title = `Ran command`;
      content = `Command: ${cmd.slice(0, 200)}`;
      if (event.tool_output) {
        content += `\nOutput: ${event.tool_output.slice(0, 200)}`;
      }
      break;
    }
    default:
      return;
  }

  await remember({
    type: "episode",
    title,
    content: `[${projectName}] ${content}`,
    tags,
    importance: 0.3,
    source: "hook",
    expiresIn: "7d",
    profile: "project",
    projectPath,
  });

  // Update conversation files_touched (deduplicated — don't append if already present)
  const sessionId = event.session_id || env.sessionId;
  const filePath = event.tool_input?.file_path;
  if (filePath) {
    await queryDB(
      `UPDATE conversations
       SET files_touched = CASE
         WHEN $1 = ANY(COALESCE(files_touched, '{}')) THEN files_touched
         ELSE array_append(COALESCE(files_touched, '{}'), $1)
       END
       WHERE session_id = $2`,
      [filePath, sessionId]
    );
  }
});
