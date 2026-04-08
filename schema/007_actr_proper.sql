-- ==========================================================
-- Shiba v0.2 — Proper ACT-R Base-Level Activation
-- Adds actr_mode parameter to scoped_recall
-- 'fast' = ln(access_count+1) approximation (default, backward compatible)
-- 'proper' = B_i = ln(SUM(t_j^(-d))) where d=0.5, using access_timestamps
-- ==========================================================

-- Helper: compute proper ACT-R base-level activation from access timestamps
CREATE OR REPLACE FUNCTION actr_activation(timestamps JSONB, decay_rate FLOAT DEFAULT 0.5)
RETURNS FLOAT AS $$
DECLARE
  now_epoch FLOAT := EXTRACT(EPOCH FROM now());
  sum_val FLOAT := 0;
  t_j FLOAT;
  age FLOAT;
  ts_elem JSONB;
BEGIN
  IF timestamps IS NULL OR jsonb_array_length(timestamps) = 0 THEN
    RETURN 0.0;
  END IF;

  FOR ts_elem IN SELECT * FROM jsonb_array_elements(timestamps) LOOP
    t_j := ts_elem::text::float;
    age := GREATEST(now_epoch - t_j, 1.0);  -- minimum 1 second to avoid division by zero
    sum_val := sum_val + power(age, -decay_rate);
  END LOOP;

  IF sum_val <= 0 THEN RETURN 0.0; END IF;
  RETURN ln(sum_val);
END;
$$ LANGUAGE plpgsql STABLE;

-- Recreate scoped_recall with actr_mode parameter
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
    actr_mode        TEXT DEFAULT 'fast'  -- 'fast' or 'proper'
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
          -- Graph boost
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
    m.profile, m.project_path,
    s.relevance,
    m.created_at
FROM scored s
JOIN memories m ON m.id = s.id
ORDER BY s.relevance DESC
LIMIT match_count;
$$ LANGUAGE sql STABLE;
