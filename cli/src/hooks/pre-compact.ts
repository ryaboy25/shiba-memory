#!/usr/bin/env node

import { runHook, getProject, type HookInput } from "./common.js";
import { remember } from "../commands/remember.js";
import { maskSecrets } from "../utils/secrets.js";
import { contentHash } from "../utils/hash.js";
import { isDuplicate } from "../utils/dedup.js";

/**
 * PreCompact hook: Save important context BEFORE Claude Code compresses it.
 * This is the biggest memory-loss prevention mechanism.
 *
 * The hook receives the conversation transcript on stdin.
 * We extract key signals and store them as episode memories.
 */

// Patterns that indicate important content worth saving
const IMPORTANCE_SIGNALS = [
  /decided to/i,
  /the reason is/i,
  /important:/i,
  /note:/i,
  /TODO:/i,
  /FIXME:/i,
  /agreed on/i,
  /changed .+ to/i,
  /switched from .+ to/i,
  /the issue was/i,
  /root cause/i,
  /the fix is/i,
  /user (wants|prefers|asked|said|mentioned|corrected)/i,
  /don't use/i,
  /always use/i,
  /never use/i,
  /remember that/i,
  /bug.*fix/i,
  /error.*resolved/i,
  /successfully/i,
  /deployed/i,
  /committed/i,
  /installed/i,
  /configured/i,
];

function extractKeyContent(input: HookInput): string | null {
  // The transcript may come as tool_response or in other fields
  const transcript = input.tool_response
    || input.transcript
    || JSON.stringify(input);

  if (typeof transcript !== "string" || transcript.length < 100) return null;

  // Extract lines that match importance signals
  const lines = transcript.split("\n");
  const importantLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length < 20 || trimmed.length > 500) continue;

    if (IMPORTANCE_SIGNALS.some((p) => p.test(trimmed))) {
      importantLines.push(trimmed);
    }
  }

  if (importantLines.length === 0) return null;

  // Cap at 20 lines to keep memory reasonable
  return importantLines.slice(0, 20).join("\n");
}

runHook(async (input) => {
  const project = getProject(input);
  const sessionId = input.session_id || "unknown";

  const keyContent = extractKeyContent(input);
  if (!keyContent) return;

  const safeContent = maskSecrets(keyContent);
  const hash = contentHash(safeContent);

  // Dedup with a longer window (10 min) since compaction is less frequent
  if (isDuplicate(hash, 600_000)) return;

  await remember({
    type: "episode",
    title: `Pre-compaction flush: ${project.name} session ${sessionId.slice(0, 8)}`,
    content: safeContent,
    tags: ["pre-compaction", "auto-captured", project.name],
    importance: 0.6,
    source: "hook",
    expiresIn: "14d",
    profile: "project",
    projectPath: project.path,
  });
});
