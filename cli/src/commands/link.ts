import { query } from "../db.js";

const VALID_RELATIONS = [
  "related", "supports", "contradicts", "supersedes", "caused_by", "derived_from",
] as const;

type Relation = (typeof VALID_RELATIONS)[number];

export async function linkMemories(
  sourceId: string,
  targetId: string,
  relation: string,
  strength: number = 0.5
): Promise<void> {
  if (!VALID_RELATIONS.includes(relation as Relation)) {
    throw new Error(`Invalid relation: ${relation}. Must be one of: ${VALID_RELATIONS.join(", ")}`);
  }

  await query(
    `INSERT INTO memory_links (source_id, target_id, relation, strength)
     VALUES ($1, $2, $3::relation_type, $4)
     ON CONFLICT (source_id, target_id, relation)
     DO UPDATE SET strength = $4`,
    [sourceId, targetId, relation, strength]
  );
}

export async function getRelated(
  memoryId: string
): Promise<
  { id: string; title: string; type: string; relation: string; strength: number; direction: string }[]
> {
  const result = await query<{
    id: string;
    title: string;
    type: string;
    relation: string;
    strength: number;
    direction: string;
  }>(
    `SELECT m.id, m.title, m.type, ml.relation::text, ml.strength,
            CASE WHEN ml.source_id = $1 THEN 'outgoing' ELSE 'incoming' END AS direction
     FROM memory_links ml
     JOIN memories m ON m.id = CASE WHEN ml.source_id = $1 THEN ml.target_id ELSE ml.source_id END
     WHERE ml.source_id = $1 OR ml.target_id = $1
     ORDER BY ml.strength DESC`,
    [memoryId]
  );

  return result.rows;
}

export async function autoLinkAll(): Promise<number> {
  // Process in batches of 50 with Promise.all for parallelism (avoids N+1)
  const BATCH_SIZE = 50;
  const result = await query<{ id: string }>(
    `SELECT id FROM memories WHERE embedding IS NOT NULL`
  );

  let totalLinks = 0;
  for (let i = 0; i < result.rows.length; i += BATCH_SIZE) {
    const batch = result.rows.slice(i, i + BATCH_SIZE);
    const linkResults = await Promise.all(
      batch.map((row) =>
        query<{ auto_link_memory: number }>(
          `SELECT auto_link_memory($1)`,
          [row.id]
        )
      )
    );
    totalLinks += linkResults.reduce((sum, r) => sum + r.rows[0].auto_link_memory, 0);
  }

  return totalLinks;
}
