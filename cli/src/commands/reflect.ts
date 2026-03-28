import { query } from "../db.js";

export interface MemoryStats {
  total_memories: number;
  by_type: Record<string, number>;
  with_embeddings: number;
  total_links: number;
  avg_confidence: number;
  oldest_memory: string | null;
  newest_memory: string | null;
}

export async function getStats(): Promise<MemoryStats> {
  const result = await query<MemoryStats>(`SELECT * FROM memory_stats()`);
  return result.rows[0];
}

export async function decayMemories(): Promise<{
  decayed: number;
  expired: number;
}> {
  const decayResult = await query(
    `UPDATE memories
     SET confidence = GREATEST(confidence * 0.9, 0.025)
     WHERE last_accessed_at < now() - interval '60 days'
        OR (last_accessed_at IS NULL AND created_at < now() - interval '60 days')`,
  );

  const expiredResult = await query<{ cleanup_expired: number }>(
    `SELECT cleanup_expired()`
  );

  return {
    decayed: decayResult.rowCount ?? 0,
    expired: expiredResult.rows[0].cleanup_expired,
  };
}

export async function findDuplicates(): Promise<
  { id1: string; id2: string; title1: string; title2: string; similarity: number }[]
> {
  const result = await query<{
    id1: string;
    id2: string;
    title1: string;
    title2: string;
    similarity: number;
  }>(
    `SELECT
       a.id AS id1, b.id AS id2,
       a.title AS title1, b.title AS title2,
       1 - (a.embedding::halfvec(512) <=> b.embedding::halfvec(512)) AS similarity
     FROM memories a
     JOIN memories b ON a.id < b.id
       AND a.type = b.type
       AND a.embedding IS NOT NULL
       AND b.embedding IS NOT NULL
     WHERE 1 - (a.embedding::halfvec(512) <=> b.embedding::halfvec(512)) > 0.92
     ORDER BY similarity DESC
     LIMIT 20`
  );

  return result.rows;
}

// ─── Consolidation (the brain's "sleep") ──────────────────

export interface ConsolidationResult {
  merged: number;
  contradictions: number;
  decayed: number;
  expired: number;
  linked: number;
  insights: number;
}

export async function consolidate(): Promise<ConsolidationResult> {
  const result: ConsolidationResult = {
    merged: 0,
    contradictions: 0,
    decayed: 0,
    expired: 0,
    linked: 0,
    insights: 0,
  };

  // Pass 1: Merge near-duplicates
  const dupes = await findDuplicates();
  for (const dupe of dupes) {
    // Keep the one with higher confidence, merge content
    const [keep, remove] = await (async () => {
      const a = await query<{ id: string; confidence: number; content: string }>(
        `SELECT id, confidence, content FROM memories WHERE id = $1`, [dupe.id1]
      );
      const b = await query<{ id: string; confidence: number; content: string }>(
        `SELECT id, confidence, content FROM memories WHERE id = $1`, [dupe.id2]
      );
      if (!a.rows[0] || !b.rows[0]) return [null, null];
      return a.rows[0].confidence >= b.rows[0].confidence
        ? [a.rows[0], b.rows[0]]
        : [b.rows[0], a.rows[0]];
    })();

    if (!keep || !remove) continue;

    // Create supersedes link
    await query(
      `INSERT INTO memory_links (source_id, target_id, relation, strength)
       VALUES ($1::uuid, $2::uuid, 'supersedes'::relation_type, $3::float)
       ON CONFLICT (source_id, target_id, relation) DO NOTHING`,
      [keep.id, remove.id, dupe.similarity]
    );

    // Delete the duplicate
    await query(`DELETE FROM memories WHERE id = $1`, [remove.id]);

    // Log
    await query(
      `INSERT INTO consolidation_log (action, details) VALUES ('merged', $1)`,
      [JSON.stringify({ kept: keep.id, removed: remove.id, similarity: dupe.similarity })]
    );

    result.merged++;
  }

  // Pass 2: Detect contradictions
  const contradictions = await query<{
    id1: string; title1: string; id2: string; title2: string; similarity: number;
  }>(`SELECT * FROM find_contradictions($1::float)`, [0.3]);

  for (const c of contradictions.rows) {
    await query(
      `INSERT INTO memory_links (source_id, target_id, relation, strength)
       VALUES ($1::uuid, $2::uuid, 'contradicts'::relation_type, $3::float)
       ON CONFLICT (source_id, target_id, relation) DO NOTHING`,
      [c.id1, c.id2, 1 - c.similarity]
    );

    await query(
      `INSERT INTO consolidation_log (action, details) VALUES ('contradiction', $1)`,
      [JSON.stringify({ id1: c.id1, title1: c.title1, id2: c.id2, title2: c.title2 })]
    );

    result.contradictions++;
  }

  // Pass 3: Decay old memories
  const decay = await decayMemories();
  result.decayed = decay.decayed;
  result.expired = decay.expired;

  // Pass 4: Auto-link unlinked memories (batch of 50)
  const unlinked = await query<{ id: string }>(
    `SELECT m.id FROM memories m
     LEFT JOIN memory_links ml ON m.id = ml.source_id OR m.id = ml.target_id
     WHERE ml.id IS NULL AND m.embedding IS NOT NULL
     LIMIT 50`
  );

  for (const row of unlinked.rows) {
    const linkResult = await query<{ auto_link_memory: number }>(
      `SELECT auto_link_memory($1, 0.6)`, [row.id]
    );
    result.linked += linkResult.rows[0].auto_link_memory;
  }

  // Pass 5: Cross-project insights
  const patterns = await query<{
    tag: string; project_count: number; memory_count: number; projects: string[];
  }>(`SELECT * FROM cross_project_patterns($1::int)`, [2]);

  for (const p of patterns.rows) {
    // Check if we already have an insight for this pattern
    const existing = await query<{ id: string }>(
      `SELECT id FROM memories
       WHERE type = 'skill' AND tags @> ARRAY['insight', $1]
       LIMIT 1`,
      [p.tag]
    );

    if (existing.rows.length === 0 && p.project_count >= 2) {
      const { embed: embedFn, pgVector: pgVecFn } = await import("../embeddings.js");
      const content = `Pattern "${p.tag}" appears across ${p.project_count} projects (${p.memory_count} memories): ${p.projects.join(", ")}`;
      const vec = await embedFn(content);

      await query(
        `INSERT INTO memories (type, title, content, embedding, tags, importance, source, profile)
         VALUES ('skill', $1, $2, $3::vector, $4, 0.6, 'consolidation', 'global')`,
        [
          `Cross-project pattern: ${p.tag}`,
          content,
          pgVecFn(vec),
          ["insight", p.tag],
        ]
      );

      await query(
        `INSERT INTO consolidation_log (action, details) VALUES ('insight', $1)`,
        [JSON.stringify(p)]
      );

      result.insights++;
    }
  }

  return result;
}
