import { query, withTransaction } from "../db.js";
import { isLLMAvailable } from "../llm.js";

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
// Each pass runs in its own transaction to avoid holding locks
// for the entire consolidation cycle (which can involve LLM calls).

export interface ConsolidationResult {
  merged: number;
  contradictions: number;
  decayed: number;
  expired: number;
  linked: number;
  insights: number;
  hashes_cleaned: number;
}

/** Pass 1: Merge near-duplicate memories. */
async function passMergeDuplicates(): Promise<number> {
  return withTransaction(async (txQuery) => {
    let merged = 0;

    const dupeResult = await txQuery<{
      id1: string; id2: string; title1: string; title2: string; similarity: number;
    }>(
      `SELECT a.id AS id1, b_match.id AS id2,
              a.title AS title1, b_match.title AS title2,
              b_match.similarity
       FROM memories a,
       LATERAL (
         SELECT m.id, m.title,
                1 - (m.embedding::halfvec(512) <=> a.embedding::halfvec(512)) AS similarity
         FROM memories m
         WHERE m.id > a.id AND m.type = a.type AND m.embedding IS NOT NULL
         ORDER BY m.embedding::halfvec(512) <=> a.embedding::halfvec(512)
         LIMIT 3
       ) b_match
       WHERE a.embedding IS NOT NULL AND b_match.similarity > 0.92
       ORDER BY b_match.similarity DESC LIMIT 20`
    );

    for (const dupe of dupeResult.rows) {
      const pair = await txQuery<{ id: string; confidence: number; content: string }>(
        `SELECT id, confidence, content FROM memories WHERE id IN ($1, $2)`,
        [dupe.id1, dupe.id2]
      );

      if (pair.rows.length < 2) continue;

      const [keep, remove] = pair.rows[0].confidence >= pair.rows[1].confidence
        ? [pair.rows[0], pair.rows[1]]
        : [pair.rows[1], pair.rows[0]];

      await txQuery(
        `INSERT INTO memory_links (source_id, target_id, relation, strength)
         VALUES ($1::uuid, $2::uuid, 'supersedes'::relation_type, $3::float)
         ON CONFLICT (source_id, target_id, relation) DO NOTHING`,
        [keep.id, remove.id, dupe.similarity]
      );

      await txQuery(`DELETE FROM memories WHERE id = $1`, [remove.id]);

      await txQuery(
        `INSERT INTO consolidation_log (action, details) VALUES ('merged', $1)`,
        [JSON.stringify({ kept: keep.id, removed: remove.id, similarity: dupe.similarity })]
      );

      merged++;
    }

    return merged;
  });
}

/** Pass 2: Detect contradictions (may call LLM — runs outside main transaction). */
async function passDetectContradictions(): Promise<number> {
  // Fetch candidates first (no transaction needed for read)
  const candidates = await query<{
    id1: string; title1: string; content1: string;
    id2: string; title2: string; content2: string;
    similarity: number;
  }>(`SELECT c.*, m1.content AS content1, m2.content AS content2
      FROM find_contradictions($1::float) c
      JOIN memories m1 ON m1.id = c.id1
      JOIN memories m2 ON m2.id = c.id2`, [0.3]);

  let contradictions = 0;

  for (const c of candidates.rows) {
    let isContradiction = true;

    // Tier 3: If LLM available, verify via NLI
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

    // Write the contradiction link in its own transaction
    await withTransaction(async (txQuery) => {
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
    });

    contradictions++;
  }

  return contradictions;
}

/** Pass 3: Decay old memories + clean up expired. */
async function passDecayAndExpire(): Promise<{ decayed: number; expired: number }> {
  return withTransaction(async (txQuery) => {
    const decayResult = await txQuery(
      `UPDATE memories
       SET confidence = GREATEST(confidence * 0.9, 0.025)
       WHERE last_accessed_at < now() - interval '60 days'
          OR (last_accessed_at IS NULL AND created_at < now() - interval '60 days')`,
    );

    const expiredResult = await txQuery<{ cleanup_expired: number }>(
      `SELECT cleanup_expired()`
    );

    return {
      decayed: decayResult.rowCount ?? 0,
      expired: expiredResult.rows[0].cleanup_expired,
    };
  });
}

/** Pass 4: Auto-link unlinked memories (batch of 50). */
async function passAutoLink(): Promise<number> {
  const unlinked = await query<{ id: string }>(
    `SELECT m.id FROM memories m
     LEFT JOIN memory_links ml ON m.id = ml.source_id OR m.id = ml.target_id
     WHERE ml.id IS NULL AND m.embedding IS NOT NULL
     LIMIT 50`
  );

  let linked = 0;
  for (const row of unlinked.rows) {
    const linkResult = await query<{ auto_link_memory: number }>(
      `SELECT auto_link_memory($1, 0.6)`, [row.id]
    );
    linked += linkResult.rows[0].auto_link_memory;
  }

  return linked;
}

/** Pass 5: Cross-project insights. */
async function passCrossProjectInsights(): Promise<number> {
  const patterns = await query<{
    tag: string; project_count: number; memory_count: number; projects: string[];
  }>(`SELECT * FROM cross_project_patterns($1::int)`, [2]);

  let insights = 0;

  for (const p of patterns.rows) {
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

      await withTransaction(async (txQuery) => {
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
      });

      insights++;
    }
  }

  return insights;
}

/** Pass 6 (NEW): Agentic reflect — LLM reviews low-confidence and
 *  high-access memories to decide: keep, boost, merge, or delete.
 *  This is the "thinking about thinking" step that Hindsight does. */
async function passAgenticReflect(): Promise<{ promoted: number; pruned: number }> {
  if (!isLLMAvailable()) return { promoted: 0, pruned: 0 };

  let promoted = 0;
  let pruned = 0;

  try {
    const { llmChat } = await import("../llm.js");

    // Find memories worth reviewing: low confidence but high access (user keeps accessing)
    // or very old high-confidence (maybe outdated)
    const candidates = await query<{
      id: string; type: string; title: string; content: string;
      confidence: number; access_count: number; created_at: string;
    }>(
      `(SELECT id, type, title, content, confidence, access_count, created_at::text
        FROM memories
        WHERE confidence < 0.4 AND access_count >= 3 AND embedding IS NOT NULL
        ORDER BY access_count DESC LIMIT 5)
       UNION ALL
       (SELECT id, type, title, content, confidence, access_count, created_at::text
        FROM memories
        WHERE confidence > 0.7 AND created_at < now() - interval '90 days'
          AND last_accessed_at < now() - interval '60 days' AND embedding IS NOT NULL
        ORDER BY created_at ASC LIMIT 5)`
    );

    if (candidates.rows.length === 0) return { promoted: 0, pruned: 0 };

    const numbered = candidates.rows
      .map((m: typeof candidates.rows[0], i: number) => `[${i}] (conf=${m.confidence.toFixed(2)}, accessed=${m.access_count}, created=${m.created_at}) [${m.type}] ${m.title}: ${m.content.slice(0, 120)}`)
      .join("\n");

    const response = await llmChat([
      {
        role: "system",
        content: `You are a memory quality reviewer for an AI assistant's memory system. Review these memories and decide for each: "boost" (increase confidence — memory is clearly valuable), "prune" (decrease confidence — memory is stale/wrong/useless), or "keep" (no change). Reply as JSON: {"decisions": [{"index": 0, "action": "boost|prune|keep", "reason": "..."}]}`,
      },
      {
        role: "user",
        content: `Review these memories:\n${numbered}`,
      },
    ], 500);

    if (!response) return { promoted: 0, pruned: 0 };

    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { promoted: 0, pruned: 0 };

    const parsed = JSON.parse(jsonMatch[0]) as {
      decisions?: { index: number; action: string; reason?: string }[];
    };

    if (!parsed.decisions) return { promoted: 0, pruned: 0 };

    for (const d of parsed.decisions) {
      if (d.index < 0 || d.index >= candidates.rows.length) continue;
      const mem = candidates.rows[d.index];

      if (d.action === "boost") {
        await query(
          `UPDATE memories SET confidence = LEAST(confidence + 0.15, 0.975) WHERE id = $1`,
          [mem.id]
        );
        await query(
          `INSERT INTO consolidation_log (action, details) VALUES ('agentic_boost', $1)`,
          [JSON.stringify({ id: mem.id, title: mem.title, reason: d.reason })]
        );
        promoted++;
      } else if (d.action === "prune") {
        await query(
          `UPDATE memories SET confidence = GREATEST(confidence - 0.2, 0.025) WHERE id = $1`,
          [mem.id]
        );
        await query(
          `INSERT INTO consolidation_log (action, details) VALUES ('agentic_prune', $1)`,
          [JSON.stringify({ id: mem.id, title: mem.title, reason: d.reason })]
        );
        pruned++;
      }
    }
  } catch {
    // Agentic reflect is optional — don't fail consolidation
  }

  return { promoted, pruned };
}

export async function consolidate(): Promise<ConsolidationResult> {
  const result: ConsolidationResult = {
    merged: 0,
    contradictions: 0,
    decayed: 0,
    expired: 0,
    linked: 0,
    insights: 0,
    hashes_cleaned: 0,
  };

  // Each pass is an independent transaction — no more holding one giant lock.
  result.merged = await passMergeDuplicates();
  result.contradictions = await passDetectContradictions();

  const decayExpire = await passDecayAndExpire();
  result.decayed = decayExpire.decayed;
  result.expired = decayExpire.expired;

  result.linked = await passAutoLink();
  result.insights = await passCrossProjectInsights();

  // Agentic reflect (LLM-based quality review)
  await passAgenticReflect();

  // Clean up feedback loop prevention hashes
  try {
    const hashResult = await query<{ cleanup_recent_hashes: number }>(
      `SELECT cleanup_recent_hashes()`
    );
    result.hashes_cleaned = hashResult.rows[0].cleanup_recent_hashes;
  } catch {
    // Table may not exist on older schemas
  }

  return result;
}
