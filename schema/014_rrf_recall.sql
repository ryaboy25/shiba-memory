-- ==========================================================
-- Shiba v0.3 — Reciprocal Rank Fusion (RRF) Recall
--
-- Replaces weighted score fusion with rank-based fusion.
-- Scores from semantic and FTS aren't on the same scale —
-- RRF uses rank positions instead, so different scales don't matter.
--
-- Also adds:
--   - User/agent filtering in SQL (not post-filter)
--   - Temporal channel (optional date range)
--   - 4-way fusion: semantic + FTS + temporal + entity graph
-- ==========================================================

DROP FUNCTION IF EXISTS scoped_recall;

CREATE OR REPLACE FUNCTION scoped_recall(
    query_embedding  vector(512),
    query_text       TEXT,
    match_count      INT DEFAULT 10,
    scope_profile    TEXT DEFAULT NULL,
    scope_project    TEXT DEFAULT NULL,
    filter_type      TEXT DEFAULT NULL,
    filter_tags      TEXT[] DEFAULT NULL,
    semantic_weight  FLOAT DEFAULT 0.5,    -- kept for backward compat but RRF ignores these
    fulltext_weight  FLOAT DEFAULT 0.5,    -- kept for backward compat
    recency_weight   FLOAT DEFAULT 0.0,
    actr_mode        TEXT DEFAULT 'fast',
    filter_user_id   TEXT DEFAULT NULL,     -- NEW: user isolation
    filter_agent_id  TEXT DEFAULT NULL,     -- NEW: agent isolation
    temporal_after   TIMESTAMPTZ DEFAULT NULL,  -- NEW: temporal channel
    temporal_before  TIMESTAMPTZ DEFAULT NULL   -- NEW: temporal channel
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
    relevance   FLOAT,
    created_at  TIMESTAMPTZ
) AS $$
WITH
-- Shared filter for all channels
base_filter AS (
    SELECT m.id
    FROM memories m
    WHERE (filter_type IS NULL OR m.type = filter_type)
      AND (filter_tags IS NULL OR m.tags && filter_tags)
      AND (m.expires_at IS NULL OR m.expires_at > now())
      AND (filter_user_id IS NULL OR m.user_id = filter_user_id OR m.user_id = 'default')
      AND (filter_agent_id IS NULL OR m.agent_id = filter_agent_id OR m.agent_id = 'default')
      AND (
        m.profile = 'global'
        OR (scope_profile IS NOT NULL AND m.profile = scope_profile)
        OR (scope_project IS NOT NULL AND m.project_path = scope_project)
      )
),

-- Channel 1: Semantic search via pgvector HNSW
semantic AS (
    SELECT
        m.id,
        ROW_NUMBER() OVER (ORDER BY m.embedding::halfvec(512) <=> query_embedding::halfvec(512)) AS rank
    FROM memories m
    JOIN base_filter bf ON bf.id = m.id
    WHERE m.embedding IS NOT NULL
    LIMIT match_count * 3
),

-- Channel 2: Full-text search via tsvector
fulltext AS (
    SELECT
        m.id,
        ROW_NUMBER() OVER (
            ORDER BY ts_rank_cd(m.fts, websearch_to_tsquery('english', query_text)) DESC
        ) AS rank
    FROM memories m
    JOIN base_filter bf ON bf.id = m.id
    WHERE m.fts @@ websearch_to_tsquery('english', query_text)
    LIMIT match_count * 3
),

-- Channel 3: Temporal matching (only active when temporal params provided)
temporal AS (
    SELECT
        m.id,
        ROW_NUMBER() OVER (ORDER BY m.created_at DESC) AS rank
    FROM memories m
    JOIN base_filter bf ON bf.id = m.id
    WHERE temporal_after IS NOT NULL
      AND (
        m.created_at BETWEEN temporal_after AND COALESCE(temporal_before, now())
        OR (m.temporal_ref IS NOT NULL AND m.temporal_ref BETWEEN temporal_after AND COALESCE(temporal_before, now()))
      )
    LIMIT match_count * 3
),

-- Channel 4: Entity graph (finds memories linked to entities matching query words)
entity_graph AS (
    SELECT
        m.id,
        ROW_NUMBER() OVER (ORDER BY me.created_at DESC) AS rank
    FROM memories m
    JOIN base_filter bf ON bf.id = m.id
    JOIN memory_entities me ON me.memory_id = m.id
    JOIN entities e ON e.id = me.entity_id
    WHERE e.canonical_name ILIKE '%' || split_part(query_text, ' ', 1) || '%'
       OR e.canonical_name ILIKE '%' || split_part(query_text, ' ', 2) || '%'
    LIMIT match_count * 3
),

-- Reciprocal Rank Fusion: combine all channels by rank position
-- RRF score = Σ 1/(k + rank_i) where k=60
-- Higher score = found in more channels and/or ranked higher
rrf AS (
    SELECT
        COALESCE(s.id, f.id, t.id, eg.id) AS id,
        COALESCE(1.0 / (60 + s.rank), 0)
          + COALESCE(1.0 / (60 + f.rank), 0)
          + COALESCE(1.0 / (60 + t.rank), 0)
          + COALESCE(1.0 / (60 + eg.rank), 0)
        AS base_score
    FROM semantic s
    FULL OUTER JOIN fulltext f ON s.id = f.id
    FULL OUTER JOIN temporal t ON COALESCE(s.id, f.id) = t.id
    FULL OUTER JOIN entity_graph eg ON COALESCE(s.id, f.id, t.id) = eg.id
),

-- Apply ACT-R + confidence + graph boost + project boost + recency
scored AS (
    SELECT
        r.id,
        r.base_score
          -- ACT-R scoring
          * CASE
              WHEN actr_mode = 'proper' THEN
                (1 + GREATEST(actr_activation(m.access_timestamps, 0.5), 0) * 0.1)
              ELSE
                (1 + LEAST(ln(m.access_count + 1), 3.0) * 0.1)
            END
          -- Confidence multiplier
          * m.confidence
          -- Graph boost: sum of relationship strengths
          * (1 + COALESCE((
              SELECT SUM(ml.strength) * 0.2
              FROM memory_links ml
              WHERE ml.source_id = r.id OR ml.target_id = r.id
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
    FROM rrf r
    JOIN memories m ON m.id = r.id
)
SELECT
    m.id, m.type, m.title, m.content, m.metadata, m.tags,
    m.profile, m.project_path,
    s.relevance,
    m.created_at
FROM scored s
JOIN memories m ON m.id = s.id
ORDER BY s.relevance DESC
LIMIT match_count;
$$ LANGUAGE sql STABLE;
