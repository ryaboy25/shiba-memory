import { readFileSync, readdirSync, statSync } from "fs";
import { resolve, extname, basename } from "path";
import { registerSource, ingestChunk, updateLastIngested } from "./common.js";
import { chunkText } from "../../utils/chunker.js";

const TEXT_EXTENSIONS = new Set([
  ".md", ".txt", ".json", ".yaml", ".yml", ".toml",
  ".ts", ".js", ".py", ".go", ".rs", ".java",
  ".sql", ".sh", ".bash", ".zsh",
  ".csv", ".xml", ".html", ".css",
  ".env.example", ".gitignore",
]);

function isTextFile(filePath: string): boolean {
  const ext = extname(filePath).toLowerCase();
  return TEXT_EXTENSIONS.has(ext) || basename(filePath).startsWith(".");
}

function collectFiles(dirPath: string, maxFiles: number = 100): string[] {
  const files: string[] = [];

  function walk(dir: string) {
    if (files.length >= maxFiles) return;

    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (files.length >= maxFiles) break;
      if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "dist") continue;

      const fullPath = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && isTextFile(fullPath)) {
        files.push(fullPath);
      }
    }
  }

  walk(dirPath);
  return files;
}

export async function ingestFile(
  targetPath: string,
  opts: { dryRun?: boolean; tags?: string[] } = {}
): Promise<{ stored: number; skipped: number; files: number }> {
  const absPath = resolve(targetPath);
  const stat = statSync(absPath);
  const sourceId = await registerSource("file", basename(absPath), undefined, absPath);

  const filePaths = stat.isDirectory() ? collectFiles(absPath) : [absPath];

  let stored = 0;
  let skipped = 0;

  for (const filePath of filePaths) {
    const content = readFileSync(filePath, "utf-8");
    if (content.length < 50) continue; // Skip tiny files

    const chunks = chunkText(content);
    const shortPath = filePath.replace(absPath, "").replace(/^\//, "") || basename(filePath);

    for (let i = 0; i < chunks.length; i++) {
      const title = chunks.length === 1
        ? `File: ${shortPath}`
        : `File: ${shortPath} (${i + 1}/${chunks.length})`;

      const result = await ingestChunk(title, chunks[i], {
        type: "reference",
        tags: ["file", ...(opts.tags || [])],
        source: "ingest",
        importance: 0.3,
        dryRun: opts.dryRun,
      }, sourceId);

      if (result.skipped) skipped++;
      else stored++;
    }
  }

  if (!opts.dryRun) {
    await updateLastIngested(sourceId);
  }

  return { stored, skipped, files: filePaths.length };
}
