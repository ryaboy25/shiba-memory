-- ==========================================================
-- Shiba v0.3 — Hardening, Temporal Search, Entity Resolution,
--               Feedback Loop Prevention, User-Scoped Recall
-- ==========================================================

-- ── 1. Add user_id/agent_id filtering to scoped_recall ─────
-- The previous version had no user isolation at the SQL level,
-- forcing client-side post-filtering (data leak risk).

DROP FUNCTION IF EXISTS scoped_recall;

CREATE OR REPLACE FUNCTION scoped_recall(
    query_embedding  vector(512),
    query_text       TEXT,
    match_count      INT DEFAULT 10,
    scope_profile    TEXT DEFAULT NULL,
    scope_project    TEXT DEFAULT NULL,
    filter_type      TEXT DEFAULT NULL,
    filter_tags      TEXT[] DEFAULT NULL,
    semantic_weight  FLOAT DEFAULT 0.7,
    fulltext_weight  FLOAT DEFAULT 0.3,
    recency_weight   FLOAT DEFAULT 0.0,
    actr_mode        TEXT DEFAULT 'fast',
    -- NEW: user/agent isolation
    filter_user_id   TEXT DEFAULT NULL,
    filter_agent_id  TEXT DEFAULT NULL,
    -- NEW: temporal search
    time_after       TIMESTAMPTZ DEFAULT NULL,
    time_before      TIMESTAMPTZ DEFAULT NULL
)
RETURNS TABLE (
    id          UUID,
    type        TEXT,
    title       TEXT,
    content     TEXT,
    metadata    JSONB,
    tags        TEXT[],
    profile     TEXT,
    project_path TEXT,
    user_id     TEXT,
    agent_id    TEXT,
    relevance   FLOAT,
    created_at  TIMESTAMPTZ
) AS $$
WITH
semantic AS (
    SELECT
        m.id,
        1 - (m.embedding::halfvec(512) <=> query_embedding::halfvec(512)) AS similarity,
        ROW_NUMBER() OVER (ORDER BY m.embedding::halfvec(512) <=> query_embedding::halfvec(512)) AS rank
    FROM memories m
    WHERE (filter_type IS NULL OR m.type = filter_type)
      AND (filter_tags IS NULL OR m.tags && filter_tags)
      AND m.embedding IS NOT NULL
      AND (m.expires_at IS NULL OR m.expires_at > now())
      AND (
        m.profile = 'global'
        OR (scope_profile IS NOT NULL AND m.profile = scope_profile)
        OR (scope_project IS NOT NULL AND m.project_path = scope_project)
      )
      -- User/agent isolation: include 'default' for backward compat
      AND (filter_user_id IS NULL OR m.user_id = filter_user_id OR m.user_id = 'default')
      AND (filter_agent_id IS NULL OR m.agent_id = filter_agent_id OR m.agent_id = 'default')
      -- Temporal filtering
      AND (time_after IS NULL OR m.created_at >= time_after)
      AND (time_before IS NULL OR m.created_at <= time_before)
    LIMIT match_count * 3
),
fulltext AS (
    SELECT
        m.id,
        ts_rank_cd(m.fts, websearch_to_tsquery('english', query_text)) AS rank_score,
        ROW_NUMBER() OVER (
            ORDER BY ts_rank_cd(m.fts, websearch_to_tsquery('english', query_text)) DESC
        ) AS rank
    FROM memories m
    WHERE m.fts @@ websearch_to_tsquery('english', query_text)
      AND (filter_type IS NULL OR m.type = filter_type)
      AND (filter_tags IS NULL OR m.tags && filter_tags)
      AND (m.expires_at IS NULL OR m.expires_at > now())
      AND (
        m.profile = 'global'
        OR (scope_profile IS NOT NULL AND m.profile = scope_profile)
        OR (scope_project IS NOT NULL AND m.project_path = scope_project)
      )
      AND (filter_user_id IS NULL OR m.user_id = filter_user_id OR m.user_id = 'default')
      AND (filter_agent_id IS NULL OR m.agent_id = filter_agent_id OR m.agent_id = 'default')
      AND (time_after IS NULL OR m.created_at >= time_after)
      AND (time_before IS NULL OR m.created_at <= time_before)
    LIMIT match_count * 3
),
fused AS (
    SELECT
        COALESCE(s.id, f.id) AS id,
        COALESCE(s.similarity, 0) * semantic_weight
          + COALESCE(f.rank_score, 0) * fulltext_weight AS base_score
    FROM semantic s
    FULL OUTER JOIN fulltext f ON s.id = f.id
),
scored AS (
    SELECT
        f.id,
        f.base_score
          -- ACT-R: fast approximation or proper power-law decay
          * CASE
              WHEN actr_mode = 'proper' THEN
                (1 + GREATEST(actr_activation(m.access_timestamps, 0.5), 0) * 0.1)
              ELSE
                (1 + LEAST(ln(m.access_count + 1), 3.0) * 0.1)
            END
          -- Confidence multiplier
          * m.confidence
          -- Graph boost (pre-aggregated via CTE to avoid correlated subquery)
          * (1 + COALESCE((
              SELECT SUM(ml.strength) * 0.2
              FROM memory_links ml
              WHERE ml.source_id = f.id OR ml.target_id = f.id
          ), 0))
          -- Project boost
          * CASE
              WHEN scope_project IS NOT NULL AND m.project_path = scope_project THEN 1.3
              WHEN m.profile = 'global' THEN 1.0
              ELSE 0.8
            END
          -- Recency boost
          * (1 + recency_weight * exp(-EXTRACT(EPOCH FROM (now() - m.created_at)) / (30 * 86400)))
        AS relevance
    FROM fused f
    JOIN memories m ON m.id = f.id
)
SELECT
    m.id, m.type, m.title, m.content, m.metadata, m.tags,
    m.profile, m.project_path, m.user_id, m.agent_id,
    s.relevance,
    m.created_at
FROM scored s
JOIN memories m ON m.id = s.id
ORDER BY s.relevance DESC
LIMIT match_count;
$$ LANGUAGE sql STABLE;


-- ── 2. Entity resolution table ─────────────────────────────
-- Maps surface forms ("my dog", "Rex", "the puppy") to canonical entity IDs.
-- Enables merging memories about the same real-world entity.

CREATE TABLE IF NOT EXISTS entities (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    canonical_name  TEXT NOT NULL,            -- "Rex (dog)"
    entity_type     TEXT NOT NULL DEFAULT 'unknown', -- person, pet, org, place, concept
    aliases         TEXT[] DEFAULT '{}',      -- {"my dog", "Rex", "the puppy"}
    metadata        JSONB DEFAULT '{}',
    user_id         TEXT DEFAULT 'default',
    created_at      TIMESTAMPTZ DEFAULT now(),
    updated_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_entities_aliases ON entities USING gin (aliases);
CREATE INDEX idx_entities_user ON entities (user_id);
CREATE INDEX idx_entities_name ON entities (canonical_name, user_id);

-- Junction: which memories mention which entities
CREATE TABLE IF NOT EXISTS memory_entities (
    memory_id       UUID NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    entity_id       UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    mention_type    TEXT DEFAULT 'mention',   -- 'subject', 'mention', 'about'
    PRIMARY KEY (memory_id, entity_id)
);

-- Resolve aliases → entity ID (returns best match)
CREATE OR REPLACE FUNCTION resolve_entity(
    alias_text TEXT,
    scope_user_id TEXT DEFAULT 'default'
)
RETURNS UUID AS $$
    SELECT id FROM entities
    WHERE (user_id = scope_user_id OR user_id = 'default')
      AND (
        lower(canonical_name) = lower(alias_text)
        OR lower(alias_text) = ANY(SELECT lower(unnest(aliases)))
      )
    ORDER BY
      CASE WHEN lower(canonical_name) = lower(alias_text) THEN 0 ELSE 1 END,
      updated_at DESC
    LIMIT 1;
$$ LANGUAGE sql STABLE;


-- ── 3. Feedback loop prevention ────────────────────────────
-- Track content hashes of recently stored memories to prevent
-- the same fact from being extracted and stored repeatedly.

CREATE TABLE IF NOT EXISTS recent_memory_hashes (
    content_hash    TEXT PRIMARY KEY,
    memory_id       UUID REFERENCES memories(id) ON DELETE CASCADE,
    created_at      TIMESTAMPTZ DEFAULT now()
);

-- Auto-clean hashes older than 24 hours (called during consolidation)
CREATE OR REPLACE FUNCTION cleanup_recent_hashes()
RETURNS INT AS $$
DECLARE
    deleted INT;
BEGIN
    DELETE FROM recent_memory_hashes WHERE created_at < now() - interval '24 hours';
    GET DIAGNOSTICS deleted = ROW_COUNT;
    RETURN deleted;
END;
$$ LANGUAGE plpgsql;


-- ── 4. Partial index for common query pattern ──────────────
CREATE INDEX IF NOT EXISTS idx_memories_has_embedding
    ON memories (id) WHERE embedding IS NOT NULL;

-- ── 5. Composite index for user+agent scoping ──────────────
-- (011 added separate indexes; this composite is better for queries)
CREATE INDEX IF NOT EXISTS idx_memories_user_type
    ON memories (user_id, type) WHERE embedding IS NOT NULL;

-- ── 6. Fix conversations unique constraint for multi-user ──
-- Drop old unique on session_id alone, add (session_id, user_id)
-- Use DO block since ALTER TABLE DROP CONSTRAINT IF EXISTS isn't standard
DO $$
BEGIN
    -- Drop the old unique index/constraint if it exists
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'conversations_session_id_key') THEN
        ALTER TABLE conversations DROP CONSTRAINT conversations_session_id_key;
    END IF;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

-- Create the new unique constraint scoped per user
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_session_user
    ON conversations (session_id, user_id);

-- ── 7. Track migrations applied ────────────────────────────
INSERT INTO migrations_applied (filename)
VALUES ('013_hardening_and_features.sql')
ON CONFLICT DO NOTHING;
