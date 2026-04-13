import { query } from "../db.js";
import { embed, pgVector } from "../embeddings.js";

export interface RecallOptions {
  query: string;
  type?: string;
  tags?: string[];
  limit?: number;
  semanticWeight?: number;
  fulltextWeight?: number;
  profile?: string;
  project?: string;
  userId?: string;
  agentId?: string;
  // Temporal search: filter by time range
  after?: string;   // ISO 8601 date — only memories created after this
  before?: string;  // ISO 8601 date — only memories created before this
  // Cross-encoder reranking: use LLM to rerank top results for accuracy
  rerank?: boolean;
  // Expand results with surrounding session context
  expandContext?: boolean;
}

export interface Memory {
  id: string;
  type: string;
  title: string;
  content: string;
  metadata: Record<string, unknown>;
  tags: string[];
  profile: string;
  project_path: string | null;
  user_id?: string;
  agent_id?: string;
  relevance: number;
  created_at: string;
}

export async function recall(opts: RecallOptions & { skipTouch?: boolean } = { query: "" }): Promise<Memory[]> {
  const vec = await embed(opts.query);

  // Auto-detect temporal queries and set date range
  let after = opts.after || null;
  let before = opts.before || null;
  if (!after && !before) {
    try {
      const { parseTemporalQuery } = await import("../extraction/temporal.js");
      const temporal = parseTemporalQuery(opts.query);
      if (temporal) {
        after = temporal.after.toISOString();
        before = temporal.before.toISOString();
      }
    } catch { /* temporal parser is optional */ }
  }

  // Query-aware retrieval policy: adjust search strategy per query type
  let policy: { depth: number; rerank: boolean; recencyWeight: number } | null = null;
  try {
    const { classifyQuery } = await import("../extraction/query_classifier.js");
    policy = classifyQuery(opts.query);
  } catch { /* classifier is optional */ }

  const filterTags = opts.tags || null;
  const limit = opts.limit || policy?.depth || 10;
  const shouldRerank = opts.rerank ?? policy?.rerank ?? false;
  const recencyWeight = policy?.recencyWeight ?? 0.0;

  // Fetch more candidates if we'll rerank (need a broader pool)
  const fetchLimit = shouldRerank ? Math.max(limit * 3, 20) : limit;

  const result = await query<Memory>(
    `SELECT * FROM scoped_recall($1::vector, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
    [
      pgVector(vec),
      opts.query,
      fetchLimit,
      opts.profile || null,
      opts.project || null,
      opts.type || null,
      filterTags,
      opts.semanticWeight ?? 0.5,
      opts.fulltextWeight ?? 0.5,
      recencyWeight,  // dynamic per query type
      "fast",  // actr_mode
      // User/agent isolation — now handled in SQL, not client-side
      opts.userId || null,
      opts.agentId || null,
      // Temporal filtering (auto-detected or explicit)
      after,
      before,
    ]
  );

  let rows = result.rows;

  // ── Cross-encoder reranking ──────────────────────────────
  // Use LLM to score query-document relevance for top results.
  // This is more accurate than embedding distance alone.
  if (shouldRerank && rows.length > 1) {
    try {
      const { isLLMAvailable, llmChat } = await import("../llm.js");
      if (isLLMAvailable()) {
        const candidates = rows.slice(0, Math.min(rows.length, 15));
        const numbered = candidates
          .map((m: Memory, i: number) => `[${i}] ${m.title}: ${m.content.slice(0, 150)}`)
          .join("\n");

        const response = await llmChat([
          {
            role: "system",
            content: `You are a relevance judge. Given a query and numbered documents, return a JSON array of document indices ordered by relevance to the query. Only include relevant documents. Example: {"ranking": [2, 0, 5]}`,
          },
          {
            role: "user",
            content: `Query: "${opts.query}"\n\nDocuments:\n${numbered}`,
          },
        ], 200);

        if (response) {
          const jsonMatch = response.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]) as { ranking?: number[] };
            if (parsed.ranking && Array.isArray(parsed.ranking)) {
              const reranked: Memory[] = [];
              for (const idx of parsed.ranking) {
                if (idx >= 0 && idx < candidates.length && !reranked.includes(candidates[idx])) {
                  reranked.push(candidates[idx]);
                }
              }
              // Append any candidates not mentioned by the LLM (safety net)
              for (const c of candidates) {
                if (!reranked.includes(c)) reranked.push(c);
              }
              rows = reranked.slice(0, limit);
            }
          }
        }
      }
    } catch {
      // Reranking is best-effort — fall back to original order
    }
  }

  // Trim to requested limit (for non-reranked case with extra fetch)
  rows = rows.slice(0, limit);

  // Context-position reordering disabled — empirically hurts LLM-as-judge
  // scoring by shuffling the best results into unexpected positions.
  // Original theory: LLMs attend most to START and END of context.
  // In practice: results are consumed by structured prompts, not raw context.

  // Graph expansion: follow knowledge graph links from top results to find
  // related memories that didn't rank high enough on their own.
  // e.g., "User has a cat" → links to → "Cat named Onix", "Onix health status"
  if (rows.length > 0) {
    try {
      const topIds = rows.slice(0, 5).map((r: Memory) => r.id);
      const existingIds = new Set(rows.map((r: Memory) => r.id));
      // How many graph results to fetch — fill up to limit, minimum 5
      const graphLimit = Math.max(limit - rows.length, 5);
      const graphResults = await query<Memory>(
        `SELECT DISTINCT m.id, m.type, m.title, m.content, m.metadata, m.tags,
                m.profile, m.project_path, ml.strength AS relevance, m.created_at::text
         FROM memory_links ml
         JOIN memories m ON m.id = CASE
           WHEN ml.source_id = ANY($1::uuid[]) THEN ml.target_id
           ELSE ml.source_id
         END
         WHERE (ml.source_id = ANY($1::uuid[]) OR ml.target_id = ANY($1::uuid[]))
           AND m.id != ALL($1::uuid[])
           AND ml.strength >= 0.5
           AND ml.relation NOT IN ('contradicts', 'supersedes')
         ORDER BY ml.strength DESC
         LIMIT $2`,
        [topIds, graphLimit]
      );
      for (const gRow of graphResults.rows) {
        if (!existingIds.has(gRow.id)) {
          rows.push(gRow);
          existingIds.add(gRow.id);
        }
      }
    } catch { /* graph traversal is best-effort */ }
  }

  // Context expansion: enrich top results with surrounding session turns
  if (opts.expandContext && rows.length > 0) {
    try {
      const { expandResults } = await import("../utils/context_expand.js");
      const expanded = await expandResults(rows.map((r: Memory) => r.id), 3, 1);
      for (const row of rows) {
        const ctx = expanded.get(row.id);
        if (ctx) {
          const parts: string[] = [];
          if (ctx.before_context) parts.push(`[Previous] ${ctx.before_context}`);
          parts.push(row.content);
          if (ctx.after_context) parts.push(`[Next] ${ctx.after_context}`);
          row.content = parts.join("\n");
        }
      }
    } catch { /* context expansion is optional */ }
  }

  // Batch-touch all returned memories (single query instead of N+1)
  if (!opts.skipTouch && rows.length > 0) {
    const ids = rows.map((r: Memory) => r.id);
    await query(
      `UPDATE memories SET access_count = access_count + 1, last_accessed_at = now()
       WHERE id = ANY($1::uuid[])`,
      [ids]
    );
  }

  return rows;
}
