import { query } from "../../db.js";
import { embed, pgVector } from "../../embeddings.js";
import { contentHash } from "../../utils/hash.js";

export interface IngestOptions {
  type: string;
  tags: string[];
  source: string;
  importance?: number;
  profile?: string;
  projectPath?: string;
  dryRun?: boolean;
  expiresIn?: string;
}

export async function registerSource(
  sourceType: string,
  name: string,
  url?: string,
  path?: string
): Promise<string> {
  const result = await query<{ id: string }>(
    `INSERT INTO ingestion_sources (source_type, name, url, path)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [sourceType, name, url || null, path || null]
  );

  if (result.rows.length > 0) return result.rows[0].id;

  // Already exists, get the id
  const existing = await query<{ id: string }>(
    `SELECT id FROM ingestion_sources WHERE source_type = $1 AND name = $2`,
    [sourceType, name]
  );
  return existing.rows[0]?.id;
}

export async function isDuplicateContent(hash: string): Promise<boolean> {
  const result = await query<{ count: string }>(
    `SELECT COUNT(*)::TEXT as count FROM ingestion_log WHERE content_hash = $1`,
    [hash]
  );
  return parseInt(result.rows[0].count) > 0;
}

export async function logIngestion(
  sourceId: string,
  hash: string,
  memoryId: string
): Promise<void> {
  await query(
    `INSERT INTO ingestion_log (source_id, content_hash, memory_id)
     VALUES ($1, $2, $3)`,
    [sourceId, hash, memoryId]
  );
}

export async function ingestChunk(
  title: string,
  content: string,
  opts: IngestOptions,
  sourceId?: string
): Promise<{ id: string; skipped: boolean }> {
  const hash = contentHash(content);

  // Check for duplicates
  if (await isDuplicateContent(hash)) {
    return { id: "", skipped: true };
  }

  if (opts.dryRun) {
    return { id: "dry-run", skipped: false };
  }

  // Generate embedding and store
  const vec = await embed(`${title} ${content}`);

  const result = await query<{ id: string }>(
    `INSERT INTO memories (type, title, content, embedding, tags, importance, source, profile, project_path, expires_at)
     VALUES ($1, $2, $3, $4::vector, $5, $6, $7, $8, $9, $10)
     RETURNING id`,
    [
      opts.type,
      title,
      content,
      pgVector(vec),
      opts.tags,
      opts.importance ?? 0.5,
      opts.source,
      opts.profile || "global",
      opts.projectPath || null,
      opts.expiresIn ? new Date(Date.now() + parseDuration(opts.expiresIn)) : null,
    ]
  );

  const memoryId = result.rows[0].id;

  // Log ingestion for dedup
  if (sourceId) {
    await logIngestion(sourceId, hash, memoryId);
  }

  // Auto-link
  await query(`SELECT auto_link_memory($1, 0.6)`, [memoryId]);

  return { id: memoryId, skipped: false };
}

function parseDuration(expr: string): number {
  const match = expr.match(/^(\d+)([dhm])$/);
  if (!match) return 30 * 86400000; // default 30 days
  const [, num, unit] = match;
  const ms = { d: 86400000, h: 3600000, m: 60000 }[unit]!;
  return parseInt(num) * ms;
}

export async function updateLastIngested(sourceId: string): Promise<void> {
  await query(
    `UPDATE ingestion_sources SET last_ingested = now() WHERE id = $1`,
    [sourceId]
  );
}
