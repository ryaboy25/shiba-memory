import { execSync } from "child_process";
import { registerSource, ingestChunk, updateLastIngested } from "./common.js";
import { detectProject, detectProjectPath } from "../../utils/project.js";

export async function ingestGit(
  targetPath: string = ".",
  opts: { dryRun?: boolean; limit?: number } = {}
): Promise<{ stored: number; skipped: number }> {
  const absPath = detectProjectPath(targetPath);
  const projectName = detectProject(targetPath);
  const sourceId = await registerSource("git", projectName, undefined, absPath);

  const limit = opts.limit || 50;

  // Get recent commits
  const logOutput = execSync(
    `git -C "${absPath}" log --oneline --no-merges -${limit} --format="%h|%s|%an|%ai"`,
    { encoding: "utf-8" }
  ).trim();

  if (!logOutput) {
    return { stored: 0, skipped: 0 };
  }

  const commits = logOutput.split("\n").map((line) => {
    const [hash, subject, author, date] = line.split("|");
    return { hash, subject, author, date };
  });

  // Get current branch
  let branch = "unknown";
  try {
    branch = execSync(`git -C "${absPath}" branch --show-current`, {
      encoding: "utf-8",
    }).trim();
  } catch { /* ignore */ }

  // Batch commits into groups of 10
  const batchSize = 10;
  let stored = 0;
  let skipped = 0;

  for (let i = 0; i < commits.length; i += batchSize) {
    const batch = commits.slice(i, i + batchSize);
    const dateRange = `${batch[batch.length - 1].date?.split(" ")[0]} to ${batch[0].date?.split(" ")[0]}`;
    const authors = [...new Set(batch.map((c) => c.author))].join(", ");

    const title = `${projectName} git activity: ${dateRange}`;
    const content = [
      `Branch: ${branch}`,
      `Authors: ${authors}`,
      `Commits (${batch.length}):`,
      ...batch.map((c) => `  ${c.hash} ${c.subject} (${c.author})`),
    ].join("\n");

    const result = await ingestChunk(title, content, {
      type: "episode",
      tags: ["git", projectName, branch],
      source: "ingest",
      importance: 0.3,
      profile: "project",
      projectPath: absPath,
      dryRun: opts.dryRun,
      expiresIn: "60d",
    }, sourceId);

    if (result.skipped) skipped++;
    else stored++;
  }

  if (!opts.dryRun) {
    await updateLastIngested(sourceId);
  }

  return { stored, skipped };
}
