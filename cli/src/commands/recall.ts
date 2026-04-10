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

  const filterTags = opts.tags || null;
  const limit = opts.limit || 10;

  // Fetch more candidates if we'll rerank (need a broader pool)
  const fetchLimit = opts.rerank ? Math.max(limit * 3, 20) : limit;

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
      0.0,     // recency_weight
      "fast",  // actr_mode
      // User/agent isolation — now handled in SQL, not client-side
      opts.userId || null,
      opts.agentId || null,
      // Temporal filtering
      opts.after || null,
      opts.before || null,
    ]
  );

  let rows = result.rows;

  // ── Cross-encoder reranking ──────────────────────────────
  // Use LLM to score query-document relevance for top results.
  // This is more accurate than embedding distance alone.
  if (opts.rerank && rows.length > 1) {
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
