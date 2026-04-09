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

  // Build user/agent filter tags for scoped_recall
  // We combine user_id/agent_id filtering with the existing tag-based scoping
  let filterTags = opts.tags || null;
  const userId = opts.userId || null;
  const agentId = opts.agentId || null;

  const result = await query<Memory>(
    `SELECT * FROM scoped_recall($1::vector, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      pgVector(vec),
      opts.query,
      // Fetch extra if we need to post-filter by user/agent
      (userId || agentId) ? (opts.limit || 10) * 3 : (opts.limit || 10),
      opts.profile || null,
      opts.project || null,
      opts.type || null,
      filterTags,
      opts.semanticWeight ?? 0.7,
      opts.fulltextWeight ?? 0.3,
    ]
  );

  // Post-filter by user_id / agent_id if specified
  let rows = result.rows;
  if (userId || agentId) {
    rows = rows.filter((r) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const row = r as any;
      if (userId && row.user_id && row.user_id !== userId && row.user_id !== "default") return false;
      if (agentId && row.agent_id && row.agent_id !== agentId && row.agent_id !== "default") return false;
      return true;
    }).slice(0, opts.limit || 10);
  }

  // Touch all returned memories (update access tracking)
  if (!opts.skipTouch) {
    for (const row of rows) {
      await query(`SELECT touch_memory($1)`, [row.id]);
    }
  }

  return rows;
}
