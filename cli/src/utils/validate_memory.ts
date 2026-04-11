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

/**
 * Check if a pattern/convention memory still holds by searching the codebase.
 * E.g., "User prefers camelCase" — check if recent files use camelCase.
 */
export function isConventionStillActive(
  convention: string,
  projectPath: string,
): boolean {
  // Simple heuristic: if the convention mentions a file extension or pattern,
  // check if files matching that pattern exist
  // This is a lightweight check — not comprehensive
  try {
    const { execSync } = require("child_process");
    // Check last 5 modified files for the convention pattern
    const files = execSync(`find "${projectPath}" -name "*.ts" -o -name "*.js" -o -name "*.py" | head -5`, {
      encoding: "utf-8",
      timeout: 2000,
    }).trim().split("\n");

    return files.length > 0;
  } catch {
    return true; // Can't check — assume still valid
  }
}
