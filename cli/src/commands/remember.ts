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

  const expiresAt = opts.expiresIn ? parseExpiry(opts.expiresIn) : null;

  const result = await query<{ id: string }>(
    `INSERT INTO memories (type, title, content, embedding, tags, importance, source, expires_at, profile, project_path, temporal_ref)
     VALUES ($1, $2, $3, $4::vector, $5, $6, $7, $8, $9, $10, $11)
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
    ]
  );

  const memoryId = result.rows[0].id;

  // Auto-link to similar existing memories
  await query(`SELECT auto_link_memory($1)`, [memoryId]);

  return memoryId;
}
