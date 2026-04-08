#!/usr/bin/env node
/**
 * Claude Code Hook: PostToolUse
 *
 * Fires after Edit, Write, or Bash tool calls.
 * Captures significant actions as episodic memories for session context.
 *
 * stdin JSON schema (from Claude Code):
 * {
 *   "session_id": "...",
 *   "tool_name": "Edit" | "Write" | "Bash",
 *   "tool_input": { ... },
 *   "tool_output": "..."
 * }
 */

import {
  safeRun,
  getHookEnv,
  parseStdinJson,
  remember,
  detectProject,
  detectProjectPath,
  query,
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
}

safeRun(async () => {
  const event = await parseStdinJson<ToolEvent>();
  if (!event?.tool_name) return;

  const env = getHookEnv();
  const projectName = detectProject(env.projectDir);
  const projectPath = detectProjectPath(env.projectDir);

  // Build a concise summary of what happened
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
      // Skip noisy commands
      if (/^(ls|cat|echo|pwd|cd)(\s|$)/.test(cmd)) return;
      title = `Ran command`;
      content = `Command: ${cmd.slice(0, 200)}`;
      if (event.tool_output) {
        const output = event.tool_output.slice(0, 200);
        content += `\nOutput: ${output}`;
      }
      break;
    }
    default:
      return;
  }

  // Store as a short-lived episode (expires in 7 days)
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

  // Update conversation files_touched
  const sessionId = event.session_id || env.sessionId;
  const filePath = event.tool_input?.file_path;
  if (filePath) {
    await query(
      `UPDATE conversations
       SET files_touched = array_append(
         COALESCE(files_touched, '{}'),
         $1
       )
       WHERE session_id = $2`,
      [filePath, sessionId]
    );
  }
});
