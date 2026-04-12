-- ==========================================================
-- Migration 019: Fix RRF fusion + benchmark optimizations
--
-- Critical fix: Replace chained FULL OUTER JOIN with UNION ALL.
-- The 5-way FULL OUTER JOIN chain drops results when a memory
-- appears only in later channels (entity_graph, substring_match)
-- because the COALESCE join conditions can miss or duplicate rows.
--
-- UNION ALL + GROUP BY is how Elasticsearch, Vespa, and every
-- production RRF implementation works.
--
-- Also: widen candidate pool (match_count * 5 for semantic),
-- and improve entity graph matching to use all query words.
-- ==========================================================

-- Ensure pg_trgm is available for similarity() in entity graph channel
CREATE EXTENSION IF NOT EXISTS pg_trgm;

DROP FUNCTION IF EXISTS scoped_recall;

CREATE OR REPLACE FUNCTION scoped_recall(
    query_embedding  vector(1024),
    query_text       TEXT,
    match_count      INT DEFAULT 10,
    scope_profile    TEXT DEFAULT NULL,
    scope_project    TEXT DEFAULT NULL,
    filter_type      TEXT DEFAULT NULL,
    filter_tags      TEXT[] DEFAULT NULL,
    semantic_weight  FLOAT DEFAULT 0.5,
    fulltext_weight  FLOAT DEFAULT 0.5,
    recency_weight   FLOAT DEFAULT 0.0,
    actr_mode        TEXT DEFAULT 'fast',
    filter_user_id   TEXT DEFAULT NULL,
    filter_agent_id  TEXT DEFAULT NULL,
    temporal_after   TIMESTAMPTZ DEFAULT NULL,
    temporal_before  TIMESTAMPTZ DEFAULT NULL
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
-- Shared base filter for all channels
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
        ROW_NUMBER() OVER (ORDER BY m.embedding::halfvec(1024) <=> query_embedding::halfvec(1024)) AS rank
    FROM memories m
    JOIN base_filter bf ON bf.id = m.id
    WHERE m.embedding IS NOT NULL
    LIMIT match_count * 5
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
    LIMIT match_count * 5
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

-- Channel 4: Entity graph — fuzzy match on canonical_name + aliases
-- Uses all significant words from query, not just first 2
entity_graph AS (
    SELECT DISTINCT ON (m.id)
        m.id,
        ROW_NUMBER() OVER (ORDER BY similarity(e.canonical_name, query_text) DESC, m.created_at DESC) AS rank
    FROM memories m
    JOIN base_filter bf ON bf.id = m.id
    JOIN memory_entities me ON me.memory_id = m.id
    JOIN entities e ON e.id = me.entity_id
    WHERE similarity(e.canonical_name, query_text) > 0.2
       OR e.canonical_name ILIKE '%' || query_text || '%'
       OR EXISTS (
           SELECT 1 FROM unnest(e.aliases) alias
           WHERE similarity(alias, query_text) > 0.2
              OR alias ILIKE '%' || query_text || '%'
       )
    LIMIT match_count * 3
),

-- Channel 5: Substring/exact match for short keyword queries only
substring_match AS (
    SELECT
        m.id,
        ROW_NUMBER() OVER (ORDER BY m.importance DESC, m.confidence DESC) AS rank
    FROM memories m
    JOIN base_filter bf ON bf.id = m.id
    WHERE array_length(string_to_array(trim(query_text), ' '), 1) <= 5
      AND query_text NOT LIKE '%?%'
      AND (m.title ILIKE '%' || query_text || '%'
       OR m.content ILIKE '%' || query_text || '%')
    LIMIT match_count * 2
),

-- *** FIX: UNION ALL + GROUP BY instead of chained FULL OUTER JOIN ***
-- This correctly handles memories that appear in any combination of channels
-- without the cartesian product / missing row bugs of the JOIN chain.
all_channels AS (
    SELECT id, rank FROM semantic
    UNION ALL
    SELECT id, rank FROM fulltext
    UNION ALL
    SELECT id, rank FROM temporal
    UNION ALL
    SELECT id, rank FROM entity_graph
    UNION ALL
    SELECT id, rank FROM substring_match
),

-- Reciprocal Rank Fusion: RRF(d) = Σ 1/(k + rank_i)
-- k=60 is standard (prevents high-ranked items from dominating)
rrf AS (
    SELECT
        id,
        SUM(1.0 / (60 + rank)) AS base_score,
        COUNT(*) AS channels_hit
    FROM all_channels
    GROUP BY id
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
          -- Multi-channel bonus: boost memories found by multiple channels
          * (1 + (r.channels_hit - 1) * 0.15)
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
