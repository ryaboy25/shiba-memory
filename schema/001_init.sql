-- ==========================================================
-- SHB — Initial Schema
-- PostgreSQL 16 + pgvector
-- ==========================================================

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ==========================================================
-- Core memory table
-- ==========================================================
CREATE TABLE memories (
    id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    type              TEXT NOT NULL CHECK (type IN (
                        'user',       -- who the user is, preferences, expertise
                        'feedback',   -- corrections, confirmations, behavior guidance
                        'project',    -- project context, goals, deadlines, decisions
                        'reference',  -- pointers to external resources
                        'episode',    -- what happened in a conversation
                        'skill'       -- learned procedures and patterns
                      )),
    title             TEXT NOT NULL,
    content           TEXT NOT NULL,
    embedding         vector(512),                              -- stored full precision
    fts               tsvector GENERATED ALWAYS AS (
                        to_tsvector('english', title || ' ' || content)
                      ) STORED,                                 -- auto full-text index
    metadata          JSONB DEFAULT '{}',
    tags              TEXT[] DEFAULT '{}',
    source            TEXT DEFAULT 'manual',                     -- 'manual', 'hook', 'skill', 'import'

    -- Scoring signals
    importance        FLOAT DEFAULT 0.5 CHECK (importance BETWEEN 0 AND 1),
    confidence        FLOAT DEFAULT 0.5 CHECK (confidence BETWEEN 0.025 AND 0.975),
    surprise          FLOAT DEFAULT 0.5 CHECK (surprise BETWEEN 0 AND 1),

    -- Access tracking (ACT-R decay)
    access_count      INT DEFAULT 0,
    last_accessed_at  TIMESTAMPTZ,

    -- Timestamps
    created_at        TIMESTAMPTZ DEFAULT now(),
    updated_at        TIMESTAMPTZ DEFAULT now(),
    expires_at        TIMESTAMPTZ                                -- NULL = never expires
);

COMMENT ON TABLE memories IS 'Core memory store — the brain of Claude Code Brain';

-- ==========================================================
-- Memory relationships (knowledge graph edges)
-- ==========================================================
CREATE TYPE relation_type AS ENUM (
    'related',
    'supports',
    'contradicts',
    'supersedes',
    'caused_by',
    'derived_from'
);

CREATE TABLE memory_links (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    source_id       UUID NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    target_id       UUID NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    relation        relation_type NOT NULL,
    strength        FLOAT DEFAULT 0.5 CHECK (strength BETWEEN 0 AND 1),
    created_at      TIMESTAMPTZ DEFAULT now(),
    UNIQUE (source_id, target_id, relation)
);

COMMENT ON TABLE memory_links IS 'Graph edges between memories — enables associative recall';

-- ==========================================================
-- Conversation summaries (episodic memory)
-- ==========================================================
CREATE TABLE conversations (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    session_id      TEXT NOT NULL,
    summary         TEXT,
    key_decisions   JSONB DEFAULT '[]',
    files_touched   TEXT[] DEFAULT '{}',
    started_at      TIMESTAMPTZ DEFAULT now(),
    ended_at        TIMESTAMPTZ,
    metadata        JSONB DEFAULT '{}'
);

CREATE TABLE conversation_memories (
    conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    memory_id       UUID NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    PRIMARY KEY (conversation_id, memory_id)
);

-- ==========================================================
-- Indexes
-- ==========================================================

-- Semantic search: HNSW on halfvec for 50% memory savings
CREATE INDEX idx_memories_embedding ON memories
    USING hnsw ((embedding::halfvec(512)) halfvec_cosine_ops)
    WITH (m = 16, ef_construction = 64);

-- Full-text search
CREATE INDEX idx_memories_fts ON memories USING gin (fts);

-- Filters
CREATE INDEX idx_memories_type ON memories (type);
CREATE INDEX idx_memories_tags ON memories USING gin (tags);
CREATE INDEX idx_memories_metadata ON memories USING gin (metadata jsonb_path_ops);
CREATE INDEX idx_memories_importance ON memories (importance DESC);
CREATE INDEX idx_memories_created ON memories (created_at DESC);
CREATE INDEX idx_memories_expires ON memories (expires_at)
    WHERE expires_at IS NOT NULL;

-- Graph lookups
CREATE INDEX idx_links_source ON memory_links (source_id, relation);
CREATE INDEX idx_links_target ON memory_links (target_id, relation);

-- Conversations
CREATE INDEX idx_conversations_session ON conversations (session_id);

-- ==========================================================
-- Triggers
-- ==========================================================

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_memories_updated
    BEFORE UPDATE ON memories
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ==========================================================
-- Core functions
-- ==========================================================

-- Touch: bump access count + timestamp (call on every recall)
CREATE OR REPLACE FUNCTION touch_memory(mid UUID)
RETURNS void AS $$
    UPDATE memories
    SET access_count = access_count + 1,
        last_accessed_at = now()
    WHERE id = mid;
$$ LANGUAGE sql;

-- Bayesian confidence update (toward 1.0 = reinforce, toward 0.0 = contradict)
CREATE OR REPLACE FUNCTION update_confidence(
    mid UUID,
    direction TEXT  -- 'reinforce' or 'contradict'
)
RETURNS FLOAT AS $$
DECLARE
    current_conf FLOAT;
    target FLOAT;
    new_conf FLOAT;
BEGIN
    SELECT confidence INTO current_conf FROM memories WHERE id = mid;
    target := CASE WHEN direction = 'reinforce' THEN 1.0 ELSE 0.0 END;
    -- Bayesian-ish update with clamping
    new_conf := 0.95 * (current_conf * 0.4 + target * 0.6) + 0.025;
    UPDATE memories SET confidence = new_conf WHERE id = mid;
    RETURN new_conf;
END;
$$ LANGUAGE plpgsql;

-- ==========================================================
-- Hybrid search: semantic + full-text with weighted fusion
-- ==========================================================
CREATE OR REPLACE FUNCTION hybrid_search(
    query_embedding  vector(512),
    query_text       TEXT,
    match_count      INT DEFAULT 10,
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
    relevance   FLOAT,
    created_at  TIMESTAMPTZ
) AS $$
WITH
-- Arm 1: Semantic search via pgvector
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
    LIMIT match_count * 3
),
-- Arm 2: Full-text search via tsvector
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
    LIMIT match_count * 3
),
-- Fuse with weighted combination
fused AS (
    SELECT
        COALESCE(s.id, f.id) AS id,
        COALESCE(s.similarity, 0) * semantic_weight
          + COALESCE(f.rank_score, 0) * fulltext_weight AS base_score
    FROM semantic s
    FULL OUTER JOIN fulltext f ON s.id = f.id
),
-- Apply ACT-R decay + confidence + graph boost
scored AS (
    SELECT
        f.id,
        f.base_score
          -- ACT-R: ln(n+1) - 0.5 * ln(age_days / (n+1))
          * (1 + LEAST(ln(m.access_count + 1), 3.0) * 0.1)
          -- Confidence multiplier
          * m.confidence
          -- Graph boost: sum of relationship strengths
          * (1 + COALESCE((
              SELECT SUM(ml.strength) * 0.2
              FROM memory_links ml
              WHERE ml.source_id = f.id OR ml.target_id = f.id
          ), 0))
        AS relevance
    FROM fused f
    JOIN memories m ON m.id = f.id
)
SELECT
    m.id, m.type, m.title, m.content, m.metadata, m.tags,
    s.relevance,
    m.created_at
FROM scored s
JOIN memories m ON m.id = s.id
ORDER BY s.relevance DESC
LIMIT match_count;
$$ LANGUAGE sql STABLE;

-- ==========================================================
-- Auto-link: find and link similar memories
-- ==========================================================
CREATE OR REPLACE FUNCTION auto_link_memory(
    mid UUID,
    similarity_threshold FLOAT DEFAULT 0.8,
    max_links INT DEFAULT 5
)
RETURNS INT AS $$
DECLARE
    mem_embedding vector(512);
    link_count INT := 0;
BEGIN
    SELECT embedding INTO mem_embedding FROM memories WHERE id = mid;
    IF mem_embedding IS NULL THEN RETURN 0; END IF;

    INSERT INTO memory_links (source_id, target_id, relation, strength)
    SELECT
        mid,
        m.id,
        'related'::relation_type,
        1 - (m.embedding::halfvec(512) <=> mem_embedding::halfvec(512))
    FROM memories m
    WHERE m.id != mid
      AND m.embedding IS NOT NULL
      AND 1 - (m.embedding::halfvec(512) <=> mem_embedding::halfvec(512)) > similarity_threshold
    ORDER BY m.embedding::halfvec(512) <=> mem_embedding::halfvec(512)
    LIMIT max_links
    ON CONFLICT (source_id, target_id, relation) DO UPDATE
        SET strength = EXCLUDED.strength;

    GET DIAGNOSTICS link_count = ROW_COUNT;
    RETURN link_count;
END;
$$ LANGUAGE plpgsql;

-- ==========================================================
-- Cleanup expired memories
-- ==========================================================
CREATE OR REPLACE FUNCTION cleanup_expired()
RETURNS INT AS $$
DECLARE
    deleted INT;
BEGIN
    DELETE FROM memories WHERE expires_at IS NOT NULL AND expires_at < now();
    GET DIAGNOSTICS deleted = ROW_COUNT;
    RETURN deleted;
END;
$$ LANGUAGE plpgsql;

-- ==========================================================
-- Stats
-- ==========================================================
CREATE OR REPLACE FUNCTION memory_stats()
RETURNS TABLE (
    total_memories  BIGINT,
    by_type         JSONB,
    with_embeddings BIGINT,
    total_links     BIGINT,
    avg_confidence  FLOAT,
    oldest_memory   TIMESTAMPTZ,
    newest_memory   TIMESTAMPTZ
) AS $$
    SELECT
        COUNT(*)::BIGINT AS total_memories,
        COALESCE(
            (SELECT jsonb_object_agg(type, cnt)
             FROM (SELECT type, COUNT(*)::BIGINT AS cnt FROM memories GROUP BY type) t),
            '{}'::JSONB
        ) AS by_type,
        COUNT(*) FILTER (WHERE embedding IS NOT NULL)::BIGINT AS with_embeddings,
        (SELECT COUNT(*)::BIGINT FROM memory_links) AS total_links,
        AVG(confidence)::FLOAT AS avg_confidence,
        MIN(created_at) AS oldest_memory,
        MAX(created_at) AS newest_memory
    FROM memories;
$$ LANGUAGE sql STABLE;
