import { disconnect } from "../db.js";
import { detectProject, detectProjectPath } from "../utils/project.js";
import type { Memory } from "../commands/recall.js";

export interface HookInput {
  session_id?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: string;
  hook_event_name?: string;
  [key: string]: unknown;
}

export async function readStdin(): Promise<HookInput> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
    process.stdin.on("error", reject);
    // Timeout after 1 second if no stdin
    setTimeout(() => resolve(data ? JSON.parse(data) : {}), 1000);
  });
}

export function getProject(input: HookInput): {
  name: string;
  path: string;
} {
  const cwd = input.cwd || process.cwd();
  return {
    name: detectProject(cwd),
    path: detectProjectPath(cwd),
  };
}

export function formatMemoriesAsMarkdown(memories: Memory[]): string {
  if (memories.length === 0) return "";

  const lines = [
    "## CCB — Recalled Memories",
    "",
  ];

  for (const m of memories) {
    lines.push(`### [${m.type}] ${m.title}`);
    lines.push(m.content);
    if (m.tags && m.tags.length > 0) {
      lines.push(`*Tags: ${m.tags.join(", ")}*`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Wrapper that handles DB lifecycle, timing, and error handling.
 * The hook function receives parsed stdin and returns optional stdout text.
 */
export async function runHook(
  fn: (input: HookInput) => Promise<string | void>
): Promise<void> {
  const start = Date.now();
  try {
    const input = await readStdin();
    const output = await fn(input);
    if (output) {
      process.stdout.write(output);
    }
  } catch (err) {
    // Errors go to stderr (Claude Code logs them but doesn't block)
    process.stderr.write(
      `[CCB hook error] ${(err as Error).message}\n`
    );
  } finally {
    const elapsed = Date.now() - start;
    if (elapsed > 1500) {
      process.stderr.write(`[CCB hook warning] Took ${elapsed}ms (budget: 2000ms)\n`);
    }
    await disconnect();
  }
}
