/**
 * Entity Resolution
 * =================
 * Maps surface forms ("my dog", "Rex") to canonical entity IDs.
 * Enables querying all memories about an entity regardless of how it was mentioned.
 *
 * Two modes:
 *   1. Manual: `shiba entity create "Rex" --type pet --aliases "my dog,the puppy"`
 *   2. Auto:   LLM-based extraction during remember/extraction hooks
 */

import { query, withTransaction } from "../db.js";
import { isLLMAvailable, llmChat } from "../llm.js";

export interface Entity {
  id: string;
  canonical_name: string;
  entity_type: string;
  aliases: string[];
  metadata: Record<string, unknown>;
  user_id: string;
  created_at: string;
}

/** Create or update an entity with aliases. */
export async function upsertEntity(opts: {
  name: string;
  type?: string;
  aliases?: string[];
  metadata?: Record<string, unknown>;
  userId?: string;
}): Promise<string> {
  const userId = opts.userId || "default";

  // Check if entity already exists (by name or alias)
  const existing = await query<{ id: string; aliases: string[] }>(
    `SELECT id, aliases FROM entities
     WHERE (user_id = $1 OR user_id = 'default')
       AND (
         lower(canonical_name) = lower($2)
         OR lower($2) = ANY(SELECT lower(unnest(aliases)))
       )
     LIMIT 1`,
    [userId, opts.name]
  );

  if (existing.rows.length > 0) {
    const entity = existing.rows[0];
    // Merge new aliases
    const newAliases = (opts.aliases || []).filter(
      (a: string) => !entity.aliases.some((existing: string) => existing.toLowerCase() === a.toLowerCase())
    );
    if (newAliases.length > 0) {
      await query(
        `UPDATE entities SET aliases = aliases || $1, updated_at = now() WHERE id = $2`,
        [newAliases, entity.id]
      );
    }
    return entity.id;
  }

  // Create new entity
  const result = await query<{ id: string }>(
    `INSERT INTO entities (canonical_name, entity_type, aliases, metadata, user_id)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [
      opts.name,
      opts.type || "unknown",
      opts.aliases || [],
      JSON.stringify(opts.metadata || {}),
      userId,
    ]
  );

  return result.rows[0].id;
}

/** Link a memory to an entity. */
export async function linkMemoryToEntity(
  memoryId: string,
  entityId: string,
  mentionType: string = "mention"
): Promise<void> {
  await query(
    `INSERT INTO memory_entities (memory_id, entity_id, mention_type)
     VALUES ($1, $2, $3)
     ON CONFLICT (memory_id, entity_id) DO UPDATE SET mention_type = $3`,
    [memoryId, entityId, mentionType]
  );
}

/** Find all memories about a specific entity (by name or alias). */
export async function recallByEntity(
  entityName: string,
  opts: { userId?: string; limit?: number } = {}
): Promise<{ entity: Entity | null; memories: { id: string; type: string; title: string; content: string; mention_type: string; created_at: string }[] }> {
  const userId = opts.userId || "default";

  // Resolve entity
  const entityResult = await query<Entity>(
    `SELECT * FROM entities
     WHERE (user_id = $1 OR user_id = 'default')
       AND (
         lower(canonical_name) = lower($2)
         OR lower($2) = ANY(SELECT lower(unnest(aliases)))
       )
     LIMIT 1`,
    [userId, entityName]
  );

  if (entityResult.rows.length === 0) {
    return { entity: null, memories: [] };
  }

  const entity = entityResult.rows[0];

  const memories = await query<{
    id: string; type: string; title: string; content: string;
    mention_type: string; created_at: string;
  }>(
    `SELECT m.id, m.type, m.title, m.content, me.mention_type, m.created_at::text
     FROM memory_entities me
     JOIN memories m ON m.id = me.memory_id
     WHERE me.entity_id = $1
     ORDER BY m.created_at DESC
     LIMIT $2`,
    [entity.id, opts.limit || 20]
  );

  return { entity, memories: memories.rows };
}

/** List all known entities. */
export async function listEntities(
  opts: { userId?: string; type?: string } = {}
): Promise<Entity[]> {
  const userId = opts.userId || "default";
  let sql = `SELECT * FROM entities WHERE (user_id = $1 OR user_id = 'default')`;
  const params: unknown[] = [userId];

  if (opts.type) {
    sql += ` AND entity_type = $2`;
    params.push(opts.type);
  }

  sql += ` ORDER BY updated_at DESC LIMIT 100`;
  const result = await query<Entity>(sql, params);
  return result.rows;
}

/**
 * Auto-extract entities from text using LLM.
 * Returns extracted entity mentions that can be linked to memories.
 */
export async function extractEntities(
  text: string,
  userId: string = "default"
): Promise<{ entityId: string; name: string; type: string; mentionType: string }[]> {
  if (!isLLMAvailable()) return [];
  if (text.length < 20) return [];

  const response = await llmChat([
    {
      role: "system",
      content: `Extract named entities from this text. Return JSON: {"entities": [{"name": "...", "type": "person|pet|org|place|tool|concept", "role": "subject|mention|about"}]}. Only include specific, named entities worth tracking long-term. Max 5 entities. Return empty array if none found.`,
    },
    {
      role: "user",
      content: text.slice(0, 500),
    },
  ], 300);

  if (!response) return [];

  try {
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return [];

    const parsed = JSON.parse(jsonMatch[0]) as {
      entities?: { name?: string; type?: string; role?: string }[];
    };

    if (!parsed.entities?.length) return [];

    const results: { entityId: string; name: string; type: string; mentionType: string }[] = [];

    for (const e of parsed.entities.slice(0, 5)) {
      if (!e.name || e.name.length < 2) continue;

      const entityId = await upsertEntity({
        name: e.name,
        type: e.type || "unknown",
        userId,
      });

      results.push({
        entityId,
        name: e.name,
        type: e.type || "unknown",
        mentionType: e.role || "mention",
      });
    }

    return results;
  } catch {
    return [];
  }
}

/**
 * Merge two entities into one. All memory links from the source
 * are transferred to the target, and aliases are merged.
 */
export async function mergeEntities(
  sourceId: string,
  targetId: string
): Promise<void> {
  await withTransaction(async (txQuery) => {
    // Get source entity
    const source = await txQuery<Entity>(
      `SELECT * FROM entities WHERE id = $1`, [sourceId]
    );
    if (source.rows.length === 0) throw new Error(`Entity ${sourceId} not found`);

    const sourceEntity = source.rows[0];

    // Merge aliases (add source name + aliases to target)
    const newAliases = [sourceEntity.canonical_name, ...sourceEntity.aliases];
    await txQuery(
      `UPDATE entities SET
         aliases = (SELECT array_agg(DISTINCT a) FROM unnest(aliases || $1) a),
         updated_at = now()
       WHERE id = $2`,
      [newAliases, targetId]
    );

    // Transfer memory links
    await txQuery(
      `UPDATE memory_entities SET entity_id = $1
       WHERE entity_id = $2
       AND memory_id NOT IN (SELECT memory_id FROM memory_entities WHERE entity_id = $1)`,
      [targetId, sourceId]
    );

    // Delete remaining (duplicate) links and the source entity
    await txQuery(`DELETE FROM memory_entities WHERE entity_id = $1`, [sourceId]);
    await txQuery(`DELETE FROM entities WHERE id = $1`, [sourceId]);
  });
}
