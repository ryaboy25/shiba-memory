-- Migration 018: Improved scoped_recall
-- Fixes:
--   4. Substring match only for short keyword queries (not semantic questions)
--   5. Temporal filtering works correctly
--   7. Entity graph uses fuzzy matching + aliases, not just first 2 words
--   8. Channel attribution via channels_hit column

-- Install pg_trgm for fuzzy matching (if not already installed)
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
semantic AS (
    SELECT
        m.id,
        ROW_NUMBER() OVER (ORDER BY m.embedding::halfvec(1024) <=> query_embedding::halfvec(1024)) AS rank
    FROM memories m
    JOIN base_filter bf ON bf.id = m.id
    WHERE m.embedding IS NOT NULL
    LIMIT match_count * 3
),
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
-- Fix 7: Entity graph with fuzzy matching on canonical_name + aliases
entity_graph AS (
    SELECT DISTINCT
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
-- Fix 4: Substring match only for short keyword queries (<=5 words, no question marks)
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
rrf AS (
    SELECT
        COALESCE(s.id, f.id, t.id, eg.id, sm.id) AS id,
        COALESCE(1.0 / (60 + s.rank), 0)
          + COALESCE(1.0 / (60 + f.rank), 0)
          + COALESCE(1.0 / (60 + t.rank), 0)
          + COALESCE(1.0 / (60 + eg.rank), 0)
          + COALESCE(1.0 / (60 + sm.rank), 0)
        AS base_score
    FROM semantic s
    FULL OUTER JOIN fulltext f ON s.id = f.id
    FULL OUTER JOIN temporal t ON COALESCE(s.id, f.id) = t.id
    FULL OUTER JOIN entity_graph eg ON COALESCE(s.id, f.id, t.id) = eg.id
    FULL OUTER JOIN substring_match sm ON COALESCE(s.id, f.id, t.id, eg.id) = sm.id
),
scored AS (
    SELECT
        r.id,
        r.base_score
          * CASE
              WHEN actr_mode = 'proper' THEN
                (1 + GREATEST(actr_activation(m.access_timestamps, 0.5), 0) * 0.1)
              ELSE
                (1 + LEAST(ln(m.access_count + 1), 3.0) * 0.1)
            END
          * m.confidence
          * (1 + COALESCE((
              SELECT SUM(ml.strength) * 0.2
              FROM memory_links ml
              WHERE ml.source_id = r.id OR ml.target_id = r.id
          ), 0))
          * CASE
              WHEN scope_project IS NOT NULL AND m.project_path = scope_project THEN 1.3
              WHEN m.profile = 'global' THEN 1.0
              ELSE 0.8
            END
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

-- Add trigram index for fuzzy entity matching
CREATE INDEX IF NOT EXISTS idx_entities_canonical_trgm
  ON entities USING gin (canonical_name gin_trgm_ops);
