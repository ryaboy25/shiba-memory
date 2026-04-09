import { query } from "../db.js";
import { embed, pgVector } from "../embeddings.js";

const VALID_TYPES = ["user", "feedback", "project", "reference", "episode", "skill", "instinct"];

export interface RememberOptions {
  type: string;
  title: string;
  content: string;
  tags?: string[];
  importance?: number;
  source?: string;
  expiresIn?: string; // e.g. "30d", "7d", "24h"
  profile?: string;
  projectPath?: string;
  temporalRef?: string; // ISO date — what time period this memory refers to
  userId?: string;     // User isolation (default: "default")
  agentId?: string;    // Agent isolation (default: "default")
}

function parseExpiry(expr: string): Date {
  const match = expr.match(/^(\d+)([dhm])$/);
  if (!match) throw new Error(`Invalid expiry format: ${expr} (use e.g. 30d, 24h, 60m)`);

  const [, num, unit] = match;
  const ms = { d: 86400000, h: 3600000, m: 60000 }[unit]!;
  return new Date(Date.now() + parseInt(num) * ms);
}

export async function remember(opts: RememberOptions): Promise<string> {
  if (!VALID_TYPES.includes(opts.type)) {
    throw new Error(`Invalid type: ${opts.type}. Must be one of: ${VALID_TYPES.join(", ")}`);
  }

  // Generate embedding from title + content
  const vec = await embed(`${opts.title} ${opts.content}`);

  // Write-time deduplication: check for existing similar memory (skip for episodes)
  if (opts.type !== "episode") {
    const existing = await query<{ id: string; confidence: number }>(
      `SELECT id, confidence FROM memories
       WHERE embedding IS NOT NULL
         AND type = $1
         AND user_id = $2
         AND 1 - (embedding::halfvec(512) <=> $3::vector::halfvec(512)) > 0.92
       ORDER BY embedding::halfvec(512) <=> $3::vector::halfvec(512)
       LIMIT 1`,
      [opts.type, opts.userId || "default", pgVector(vec)]
    );

    if (existing.rows.length > 0) {
      // Similar memory exists — reinforce confidence instead of creating duplicate
      const match = existing.rows[0];
      await query(
        `UPDATE memories SET confidence = LEAST(confidence + 0.05, 0.975), updated_at = now() WHERE id = $1`,
        [match.id]
      );
      await query(`SELECT touch_memory($1)`, [match.id]);
      return match.id;
    }
  }

  const expiresAt = opts.expiresIn ? parseExpiry(opts.expiresIn) : null;

  const result = await query<{ id: string }>(
    `INSERT INTO memories (type, title, content, embedding, tags, importance, source, expires_at, profile, project_path, temporal_ref, user_id, agent_id)
     VALUES ($1, $2, $3, $4::vector, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     RETURNING id`,
    [
      opts.type,
      opts.title,
      opts.content,
      pgVector(vec),
      opts.tags || [],
      opts.importance ?? 0.5,
      opts.source || "manual",
      expiresAt,
      opts.profile || "global",
      opts.projectPath || null,
      opts.temporalRef || null,
      opts.userId || "default",
      opts.agentId || "default",
    ]
  );

  const memoryId = result.rows[0].id;

  // Auto-link to similar existing memories
  await query(`SELECT auto_link_memory($1)`, [memoryId]);

  return memoryId;
}
