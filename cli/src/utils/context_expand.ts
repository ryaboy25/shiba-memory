/**
 * Contextualized Retrieval — Expand Hits
 * ========================================
 * When a memory matches, grab surrounding conversation turns for context.
 * Inspired by MemMachine's "contextualized retrieval" approach.
 */

import { query } from "../db.js";

interface ExpandedMemory {
  id: string;
  content: string;
  before_context?: string;
  after_context?: string;
}

/**
 * Expand a recalled memory with its neighboring turns from the same session.
 * Uses created_at proximity to find adjacent memories.
 */
export async function expandWithContext(
  memoryId: string,
  windowSize: number = 1,
): Promise<ExpandedMemory | null> {
  // Get the memory and its session tag
  const mem = await query<{
    id: string; content: string; created_at: string; tags: string[];
  }>(
    `SELECT id, content, created_at, tags FROM memories WHERE id = $1`,
    [memoryId]
  );

  if (!mem.rows[0]) return null;

  const row = mem.rows[0];
  const sessionTag = row.tags?.find((t: string) => t.startsWith("session-"));
  if (!sessionTag) return { id: row.id, content: row.content };

  // Get adjacent memories from the same session
  const before = await query<{ content: string }>(
    `SELECT content FROM memories
     WHERE tags @> ARRAY[$1]
       AND created_at < $2
     ORDER BY created_at DESC
     LIMIT $3`,
    [sessionTag, row.created_at, windowSize]
  );

  const after = await query<{ content: string }>(
    `SELECT content FROM memories
     WHERE tags @> ARRAY[$1]
       AND created_at > $2
     ORDER BY created_at ASC
     LIMIT $3`,
    [sessionTag, row.created_at, windowSize]
  );

  return {
    id: row.id,
    content: row.content,
    before_context: before.rows.map((r) => r.content).join("\n"),
    after_context: after.rows.map((r) => r.content).join("\n"),
  };
}

/**
 * Expand multiple recalled memories with context.
 * Only expands the top N results to limit DB queries.
 */
export async function expandResults(
  memoryIds: string[],
  topN: number = 3,
  windowSize: number = 1,
): Promise<Map<string, ExpandedMemory>> {
  const expanded = new Map<string, ExpandedMemory>();

  for (const id of memoryIds.slice(0, topN)) {
    const result = await expandWithContext(id, windowSize);
    if (result) expanded.set(id, result);
  }

  return expanded;
}
