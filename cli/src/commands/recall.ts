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
  relevance: number;
  created_at: string;
}

export async function recall(opts: RecallOptions & { skipTouch?: boolean } = { query: "" }): Promise<Memory[]> {
  const vec = await embed(opts.query);

  const result = await query<Memory>(
    `SELECT * FROM scoped_recall($1::vector, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      pgVector(vec),
      opts.query,
      opts.limit || 10,
      opts.profile || null,
      opts.project || null,
      opts.type || null,
      opts.tags || null,
      opts.semanticWeight ?? 0.7,
      opts.fulltextWeight ?? 0.3,
    ]
  );

  // Touch all returned memories (update access tracking)
  // Skip in hooks for speed
  if (!opts.skipTouch) {
    for (const row of result.rows) {
      await query(`SELECT touch_memory($1)`, [row.id]);
    }
  }

  return result.rows;
}
