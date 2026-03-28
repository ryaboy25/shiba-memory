-- ==========================================================
-- CCB v0.1 — Profiles, Scoping & Ingestion Support
-- ==========================================================

-- Profile scoping: memories can be global or project-specific
ALTER TABLE memories ADD COLUMN IF NOT EXISTS profile TEXT DEFAULT 'global';
ALTER TABLE memories ADD COLUMN IF NOT EXISTS project_path TEXT;  -- e.g. /mnt/c/Users/Ryabo/source/repos/hedgebettor

CREATE INDEX idx_memories_profile ON memories (profile);
CREATE INDEX idx_memories_project ON memories (project_path) WHERE project_path IS NOT NULL;

-- Ingestion source tracking
CREATE TABLE IF NOT EXISTS ingestion_sources (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    source_type     TEXT NOT NULL CHECK (source_type IN ('rss', 'web', 'git', 'file', 'news')),
    name            TEXT NOT NULL,
    url             TEXT,
    path            TEXT,
    schedule        TEXT,                -- cron expression e.g. '0 */6 * * *'
    last_ingested   TIMESTAMPTZ,
    config          JSONB DEFAULT '{}',
    enabled         BOOLEAN DEFAULT true,
    created_at      TIMESTAMPTZ DEFAULT now()
);

-- Ingestion log: track what we've already processed
CREATE TABLE IF NOT EXISTS ingestion_log (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    source_id       UUID REFERENCES ingestion_sources(id) ON DELETE CASCADE,
    content_hash    TEXT NOT NULL,       -- SHA-256 of ingested content (dedup)
    memory_id       UUID REFERENCES memories(id) ON DELETE SET NULL,
    ingested_at     TIMESTAMPTZ DEFAULT now(),
    metadata        JSONB DEFAULT '{}'
);

CREATE INDEX idx_ingestion_log_hash ON ingestion_log (content_hash);
CREATE INDEX idx_ingestion_log_source ON ingestion_log (source_id, ingested_at DESC);

-- Consolidation log: track merge/insight operations
CREATE TABLE IF NOT EXISTS consolidation_log (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    action          TEXT NOT NULL,       -- 'merged', 'decayed', 'insight', 'contradiction'
    details         JSONB NOT NULL,
    created_at      TIMESTAMPTZ DEFAULT now()
);

-- Profile-aware recall: same hybrid search but scoped
CREATE OR REPLACE FUNCTION scoped_recall(
    query_embedding  vector(512),
    query_text       TEXT,
    match_count      INT DEFAULT 10,
    scope_profile    TEXT DEFAULT NULL,
    scope_project    TEXT DEFAULT NULL,
    filter_type      TEXT DEFAULT NULL,
    filter_tags      TEXT[] DEFAULT NULL,
    semantic_weight  FLOAT DEFAULT 0.7,
    fulltext_weight  FLOAT DEFAULT 0.3
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
      -- Scoping: include global + matching profile/project
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
          * (1 + LEAST(ln(m.access_count + 1), 3.0) * 0.1)
          * m.confidence
          * (1 + COALESCE((
              SELECT SUM(ml.strength) * 0.2
              FROM memory_links ml
              WHERE ml.source_id = f.id OR ml.target_id = f.id
          ), 0))
          -- Boost project-specific memories when in that project
          * CASE
              WHEN scope_project IS NOT NULL AND m.project_path = scope_project THEN 1.3
              WHEN m.profile = 'global' THEN 1.0
              ELSE 0.8
            END
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

-- Find contradictions: memories of same type with high dissimilarity but overlapping keywords
CREATE OR REPLACE FUNCTION find_contradictions(threshold FLOAT DEFAULT 0.3)
RETURNS TABLE (
    id1 UUID, title1 TEXT, id2 UUID, title2 TEXT,
    similarity FLOAT, shared_tags TEXT[]
) AS $$
    SELECT
        a.id, a.title, b.id, b.title,
        1 - (a.embedding::halfvec(512) <=> b.embedding::halfvec(512)) AS similarity,
        ARRAY(SELECT unnest(a.tags) INTERSECT SELECT unnest(b.tags)) AS shared_tags
    FROM memories a
    JOIN memories b ON a.id < b.id
        AND a.type = b.type
        AND a.embedding IS NOT NULL
        AND b.embedding IS NOT NULL
        AND a.tags && b.tags  -- must share at least one tag
    WHERE 1 - (a.embedding::halfvec(512) <=> b.embedding::halfvec(512)) < threshold
    ORDER BY similarity ASC
    LIMIT 20;
$$ LANGUAGE sql STABLE;

-- Cross-project insights: find patterns that appear across multiple projects
CREATE OR REPLACE FUNCTION cross_project_patterns(min_projects INT DEFAULT 2)
RETURNS TABLE (
    tag TEXT,
    project_count BIGINT,
    memory_count BIGINT,
    projects TEXT[]
) AS $$
    SELECT
        unnest(tags) AS tag,
        COUNT(DISTINCT project_path) AS project_count,
        COUNT(*) AS memory_count,
        ARRAY_AGG(DISTINCT project_path) FILTER (WHERE project_path IS NOT NULL) AS projects
    FROM memories
    WHERE project_path IS NOT NULL
    GROUP BY unnest(tags)
    HAVING COUNT(DISTINCT project_path) >= min_projects
    ORDER BY project_count DESC, memory_count DESC;
$$ LANGUAGE sql STABLE;
