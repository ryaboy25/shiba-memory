import { query, withTransaction } from "../db.js";
import { isLLMAvailable } from "../llm.js";
import type pg from "pg";

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

/** Find near-duplicate memories using KNN lateral join (HNSW-accelerated, not O(n²)). */
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
    `SELECT a.id AS id1, b_match.id AS id2,
            a.title AS title1, b_match.title AS title2,
            b_match.similarity
     FROM memories a,
     LATERAL (
       SELECT m.id, m.title,
              1 - (m.embedding::halfvec(512) <=> a.embedding::halfvec(512)) AS similarity
       FROM memories m
       WHERE m.id > a.id
         AND m.type = a.type
         AND m.embedding IS NOT NULL
       ORDER BY m.embedding::halfvec(512) <=> a.embedding::halfvec(512)
       LIMIT 3
     ) b_match
     WHERE a.embedding IS NOT NULL
       AND b_match.similarity > 0.92
     ORDER BY b_match.similarity DESC
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
  return withTransaction(async (txQuery) => {
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
      // Fetch both memories in a single query (fix N+1)
      const pair = await txQuery<{ id: string; confidence: number; content: string }>(
        `SELECT id, confidence, content FROM memories WHERE id IN ($1, $2)`,
        [dupe.id1, dupe.id2]
      );

      if (pair.rows.length < 2) continue;

      const [keep, remove] = pair.rows[0].confidence >= pair.rows[1].confidence
        ? [pair.rows[0], pair.rows[1]]
        : [pair.rows[1], pair.rows[0]];

      // Create supersedes link
      await txQuery(
        `INSERT INTO memory_links (source_id, target_id, relation, strength)
         VALUES ($1::uuid, $2::uuid, 'supersedes'::relation_type, $3::float)
         ON CONFLICT (source_id, target_id, relation) DO NOTHING`,
        [keep.id, remove.id, dupe.similarity]
      );

      // Delete the duplicate
      await txQuery(`DELETE FROM memories WHERE id = $1`, [remove.id]);

      // Log
      await txQuery(
        `INSERT INTO consolidation_log (action, details) VALUES ('merged', $1)`,
        [JSON.stringify({ kept: keep.id, removed: remove.id, similarity: dupe.similarity })]
      );

      result.merged++;
    }

    // Pass 2: Detect contradictions
    // First: find candidates via embedding distance (fast, may have false positives)
    const candidates = await txQuery<{
      id1: string; title1: string; content1: string;
      id2: string; title2: string; content2: string;
      similarity: number;
    }>(`SELECT c.*, m1.content AS content1, m2.content AS content2
        FROM find_contradictions($1::float) c
        JOIN memories m1 ON m1.id = c.id1
        JOIN memories m2 ON m2.id = c.id2`, [0.3]);

    for (const c of candidates.rows) {
      let isContradiction = true;

      // Tier 3: If LLM available, verify via NLI (embedding distance alone is unreliable)
      if (isLLMAvailable()) {
        try {
          const { checkContradiction } = await import("../extraction/targeted.js");
          const nli = await checkContradiction(c.content1, c.content2);
          isContradiction = nli.contradicts;
        } catch {
          // LLM failure — fall back to embedding-based detection
        }
      }

      if (!isContradiction) continue;

      await txQuery(
        `INSERT INTO memory_links (source_id, target_id, relation, strength)
         VALUES ($1::uuid, $2::uuid, 'contradicts'::relation_type, $3::float)
         ON CONFLICT (source_id, target_id, relation) DO NOTHING`,
        [c.id1, c.id2, 1 - c.similarity]
      );

      await txQuery(
        `INSERT INTO consolidation_log (action, details) VALUES ('contradiction', $1)`,
        [JSON.stringify({ id1: c.id1, title1: c.title1, id2: c.id2, title2: c.title2, llm_verified: isLLMAvailable() })]
      );

      result.contradictions++;
    }

    // Pass 3: Decay old memories
    const decayResult = await txQuery(
      `UPDATE memories
       SET confidence = GREATEST(confidence * 0.9, 0.025)
       WHERE last_accessed_at < now() - interval '60 days'
          OR (last_accessed_at IS NULL AND created_at < now() - interval '60 days')`,
    );
    result.decayed = decayResult.rowCount ?? 0;

    const expiredResult = await txQuery<{ cleanup_expired: number }>(
      `SELECT cleanup_expired()`
    );
    result.expired = expiredResult.rows[0].cleanup_expired;

    // Pass 4: Auto-link unlinked memories (batch of 50)
    const unlinked = await txQuery<{ id: string }>(
      `SELECT m.id FROM memories m
       LEFT JOIN memory_links ml ON m.id = ml.source_id OR m.id = ml.target_id
       WHERE ml.id IS NULL AND m.embedding IS NOT NULL
       LIMIT 50`
    );

    for (const row of unlinked.rows) {
      const linkResult = await txQuery<{ auto_link_memory: number }>(
        `SELECT auto_link_memory($1, 0.6)`, [row.id]
      );
      result.linked += linkResult.rows[0].auto_link_memory;
    }

    // Pass 5: Cross-project insights
    const patterns = await txQuery<{
      tag: string; project_count: number; memory_count: number; projects: string[];
    }>(`SELECT * FROM cross_project_patterns($1::int)`, [2]);

    for (const p of patterns.rows) {
      const existing = await txQuery<{ id: string }>(
        `SELECT id FROM memories
         WHERE type = 'skill' AND tags @> ARRAY['insight', $1]
         LIMIT 1`,
        [p.tag]
      );

      if (existing.rows.length === 0 && p.project_count >= 2) {
        const { embed: embedFn, pgVector: pgVecFn } = await import("../embeddings.js");
        const content = `Pattern "${p.tag}" appears across ${p.project_count} projects (${p.memory_count} memories): ${p.projects.join(", ")}`;
        const vec = await embedFn(content);

        await txQuery(
          `INSERT INTO memories (type, title, content, embedding, tags, importance, source, profile)
           VALUES ('skill', $1, $2, $3::vector, $4, 0.6, 'consolidation', 'global')`,
          [
            `Cross-project pattern: ${p.tag}`,
            content,
            pgVecFn(vec),
            ["insight", p.tag],
          ]
        );

        await txQuery(
          `INSERT INTO consolidation_log (action, details) VALUES ('insight', $1)`,
          [JSON.stringify(p)]
        );

        result.insights++;
      }
    }

    return result;
  });
}
