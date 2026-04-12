import { query, withTransaction } from "../db.js";
import { embed, pgVector } from "../embeddings.js";
import { createHash } from "crypto";

const VALID_TYPES = ["user", "feedback", "project", "reference", "episode", "skill", "instinct"];

// Configurable dedup threshold — different embedding models have different similarity distributions.
const DEDUP_THRESHOLD = parseFloat(process.env.SHB_DEDUP_THRESHOLD || "0.92");

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
  confidence?: number; // Override confidence (0.025-0.975, default: schema default 0.5)
  temporalRef?: string; // ISO date — what time period this memory refers to
  createdAt?: string;  // Override created_at timestamp (ISO 8601)
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

/** SHA-256 hash of content for feedback loop prevention. */
function contentHash(type: string, content: string): string {
  return createHash("sha256").update(`${type}:${content}`).digest("hex").slice(0, 32);
}

// Max chars for a single embedding — beyond this, chunk and store multiple
const MAX_EMBED_CONTENT = 1500;

export async function remember(opts: RememberOptions): Promise<string> {
  if (!VALID_TYPES.includes(opts.type)) {
    throw new Error(`Invalid type: ${opts.type}. Must be one of: ${VALID_TYPES.join(", ")}`);
  }

  // ── Chunking: split long content into linked chunk memories ──
  const fullText = `${opts.title} ${opts.content}`;
  if (fullText.length > MAX_EMBED_CONTENT && opts.type !== "episode") {
    const { chunkText } = await import("../utils/chunker.js");
    const chunks = chunkText(opts.content, MAX_EMBED_CONTENT, 200);
    if (chunks.length > 1) {
      // Store first chunk as the primary memory
      const primaryId = await rememberSingle({ ...opts, content: chunks[0] });
      // Store remaining chunks as linked memories
      for (let i = 1; i < chunks.length; i++) {
        const chunkId = await rememberSingle({
          ...opts,
          title: `${opts.title} [${i + 1}/${chunks.length}]`,
          content: chunks[i],
          tags: [...(opts.tags || []), "chunk", `chunk-${i + 1}-of-${chunks.length}`],
        });
        // Link chunk to primary
        await query(
          `INSERT INTO memory_links (source_id, target_id, relation, strength)
           VALUES ($1, $2, 'related'::relation_type, 0.9)
           ON CONFLICT DO NOTHING`,
          [primaryId, chunkId]
        ).catch(() => {});
      }
      return primaryId;
    }
  }

  return rememberSingle(opts);
}

async function rememberSingle(opts: RememberOptions): Promise<string> {
  // ── Feedback loop prevention ─────────────────────────────
  // Check if we recently stored this exact content (prevents extraction loops)
  const hash = contentHash(opts.type, opts.content);
  const recentDup = await query<{ memory_id: string }>(
    `SELECT memory_id FROM recent_memory_hashes WHERE content_hash = $1`,
    [hash]
  ).catch(() => ({ rows: [] as { memory_id: string }[] })); // table may not exist on older schemas

  if (recentDup.rows.length > 0) {
    return recentDup.rows[0].memory_id; // Already stored recently, skip
  }

  // Generate embedding from title + content
  const vec = await embed(`${opts.title} ${opts.content}`);

  // ── Transaction: dedup check + insert (prevents race condition) ──
  return withTransaction(async (txQuery) => {
    // Write-time deduplication: check for existing similar memory (skip for episodes)
    if (opts.type !== "episode") {
      const existing = await txQuery<{ id: string; confidence: number }>(
        `SELECT id, confidence FROM memories
         WHERE embedding IS NOT NULL
           AND type = $1
           AND user_id = $2
           AND 1 - (embedding::halfvec(1024) <=> $3::vector::halfvec(1024)) > $4
         ORDER BY embedding::halfvec(1024) <=> $3::vector::halfvec(1024)
         LIMIT 1`,
        [opts.type, opts.userId || "default", pgVector(vec), DEDUP_THRESHOLD]
      );

      if (existing.rows.length > 0) {
        // Similar memory exists — reinforce confidence instead of creating duplicate
        const match = existing.rows[0];
        await txQuery(
          `UPDATE memories SET confidence = LEAST(confidence + 0.05, 0.975), updated_at = now() WHERE id = $1`,
          [match.id]
        );
        await txQuery(`SELECT touch_memory($1)`, [match.id]);

        // Record hash to prevent feedback loops
        await txQuery(
          `INSERT INTO recent_memory_hashes (content_hash, memory_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [hash, match.id]
        ).catch(() => {}); // table may not exist

        return match.id;
      }
    }

    const expiresAt = opts.expiresIn ? parseExpiry(opts.expiresIn) : null;

    // Build INSERT dynamically based on which optional fields are provided
    const cols = ["type", "title", "content", "embedding", "tags", "importance", "source", "expires_at", "profile", "project_path", "temporal_ref", "user_id", "agent_id"];
    const vals: unknown[] = [
      opts.type, opts.title, opts.content, pgVector(vec),
      opts.tags || [], opts.importance ?? 0.5,
      opts.source || "manual", expiresAt,
      opts.profile || "global", opts.projectPath || null,
      opts.temporalRef || null, opts.userId || "default", opts.agentId || "default",
    ];

    if (opts.confidence !== undefined) {
      cols.push("confidence");
      vals.push(opts.confidence);
    }
    if (opts.createdAt) {
      cols.push("created_at");
      vals.push(opts.createdAt);
    }

    const placeholders = vals.map((_, i) => i === 3 ? `$${i + 1}::vector` : `$${i + 1}`).join(", ");
    const result = await txQuery<{ id: string }>(
      `INSERT INTO memories (${cols.join(", ")}) VALUES (${placeholders}) RETURNING id`,
      vals
    );

    const memoryId = result.rows[0].id;

    // Auto-link to similar existing memories
    await txQuery(`SELECT auto_link_memory($1)`, [memoryId]);

    // Record hash to prevent feedback loops
    await txQuery(
      `INSERT INTO recent_memory_hashes (content_hash, memory_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [hash, memoryId]
    ).catch(() => {}); // table may not exist

    return memoryId;
  });
}
