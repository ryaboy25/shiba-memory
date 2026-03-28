#!/usr/bin/env node

import { runHook, getProject, formatMemoriesAsMarkdown } from "./common.js";
import { recall } from "../commands/recall.js";

// After context compaction, re-inject relevant memories
// Same logic as session-start — the context was just wiped
runHook(async (input) => {
  const project = getProject(input);

  const projectMemories = await recall({
    query: project.name,
    project: project.path,
    limit: 8,
    skipTouch: true,
  });

  const userMemories = await recall({
    query: "user preferences role expertise",
    type: "user",
    limit: 3,
    skipTouch: true,
  });

  const seen = new Set<string>();
  const all = [...userMemories, ...projectMemories].filter((m) => {
    if (seen.has(m.id)) return false;
    seen.add(m.id);
    return true;
  });

  if (all.length === 0) return;

  return formatMemoriesAsMarkdown(all);
});
