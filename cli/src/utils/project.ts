import { existsSync } from "fs";
import { dirname, basename, resolve } from "path";

/**
 * Walk up from cwd to find a .git directory, return the repo basename.
 * Falls back to cwd basename if no .git found.
 */
export function detectProject(cwd: string): string {
  let dir = resolve(cwd);
  const root = dirname(dir) === dir; // filesystem root

  while (!root) {
    if (existsSync(resolve(dir, ".git"))) {
      return basename(dir);
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return basename(cwd);
}

/**
 * Get the git root path (not just the name).
 */
export function detectProjectPath(cwd: string): string {
  let dir = resolve(cwd);

  while (true) {
    if (existsSync(resolve(dir, ".git"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return cwd;
}
