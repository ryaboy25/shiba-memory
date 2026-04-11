/**
 * Memory Validation Against Live Code
 * =====================================
 * Before injecting code-related memories, check if they still match
 * the current codebase state. Prevents stale memories from causing harm.
 * Inspired by GitHub Copilot's memory validation.
 */

import { existsSync, readFileSync } from "fs";
import { resolve } from "path";

/**
 * Check if a memory is still valid against the current codebase.
 * Returns a confidence modifier (0.0-1.0).
 * - 1.0 = validated or not code-related
 * - 0.5 = code reference exists but content may have changed
 * - 0.1 = code reference no longer exists (stale)
 */
export function validateMemory(
  memoryContent: string,
  memoryTags: string[],
  projectPath?: string | null,
): number {
  // Only validate memories that reference code
  if (!projectPath) return 1.0;

  // Check if memory mentions a file path
  const filePatterns = memoryContent.match(/(?:File|Edited|Created|Modified):\s*([^\n,]+\.\w+)/gi);
  if (!filePatterns || filePatterns.length === 0) return 1.0;

  let validCount = 0;
  let checkCount = 0;

  for (const match of filePatterns) {
    const filePath = match.replace(/^(?:File|Edited|Created|Modified):\s*/i, "").trim();
    const fullPath = resolve(projectPath, filePath);
    checkCount++;

    if (existsSync(fullPath)) {
      validCount++;
    }
  }

  if (checkCount === 0) return 1.0;
  if (validCount === 0) return 0.1; // All referenced files are gone — stale
  return 0.5 + (validCount / checkCount) * 0.5; // Partial validity
}

// isConventionStillActive removed — was dead code with command injection risk
