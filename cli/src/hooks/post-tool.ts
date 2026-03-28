#!/usr/bin/env node

import { runHook, getProject, type HookInput } from "./common.js";
import { remember } from "../commands/remember.js";
import { maskSecrets } from "../utils/secrets.js";
import { contentHash } from "../utils/hash.js";
import { isDuplicate } from "../utils/dedup.js";

// Tools that are read-only — skip these
const SKIP_TOOLS = new Set([
  "Read", "Glob", "Grep", "WebSearch", "WebFetch",
  "TodoRead", "TaskGet", "TaskList",
]);

// Bash commands that are read-only — skip these
const SKIP_BASH_PATTERNS = [
  /^\s*(ls|pwd|echo|cat|head|tail|wc|file|which|whoami|hostname|date|uname)\b/,
  /^\s*git\s+(status|log|diff|show|branch|remote|tag)\b/,
  /^\s*docker\s+(ps|images|logs|inspect|port)\b/,
  /^\s*npm\s+(list|ls|outdated|view)\b/,
];

function shouldSkipTool(input: HookInput): boolean {
  const toolName = input.tool_name || "";

  // Skip read-only tools
  if (SKIP_TOOLS.has(toolName)) return true;

  // For Bash, skip read-only commands
  if (toolName === "Bash") {
    const cmd = String(input.tool_input?.command || "");
    if (SKIP_BASH_PATTERNS.some((p) => p.test(cmd))) return true;
  }

  return false;
}

function isSignificant(input: HookInput): boolean {
  const response = String(input.tool_response || "");

  // Skip tiny responses (likely trivial operations)
  if (response.length < 50) return false;

  return true;
}

function extractContent(input: HookInput): { title: string; content: string } {
  const toolName = input.tool_name || "Unknown";
  const toolInput = input.tool_input || {};

  if (toolName === "Edit" || toolName === "Write") {
    const filePath = String(toolInput.file_path || "unknown");
    const shortPath = filePath.split("/").slice(-3).join("/");
    return {
      title: `Modified ${shortPath}`,
      content: `${toolName} on ${filePath}. ${toolInput.old_string ? "Replaced content." : "Wrote file."}`,
    };
  }

  if (toolName === "Bash") {
    const cmd = String(toolInput.command || "");
    const response = String(input.tool_response || "").slice(0, 300);
    return {
      title: `Ran: ${cmd.slice(0, 80)}`,
      content: `Command: ${cmd}\nOutput: ${response}`,
    };
  }

  // Generic fallback
  return {
    title: `${toolName} action`,
    content: JSON.stringify(toolInput).slice(0, 500),
  };
}

runHook(async (input) => {
  // Stage 1: Tool filter
  if (shouldSkipTool(input)) return;

  // Stage 2: Significance filter
  if (!isSignificant(input)) return;

  // Stage 3: Extract content
  const { title, content } = extractContent(input);

  // Stage 4: Mask secrets
  const safeContent = maskSecrets(content);
  const safeTitle = maskSecrets(title);

  // Stage 5: Dedup check
  const hash = contentHash(safeTitle + safeContent);
  if (isDuplicate(hash)) return;

  // Stage 6: Store as episode memory
  const project = getProject(input);

  await remember({
    type: "episode",
    title: safeTitle,
    content: safeContent,
    tags: ["auto-captured", project.name],
    importance: 0.4,
    source: "hook",
    expiresIn: "30d",
    profile: "project",
    projectPath: project.path,
  });
});
