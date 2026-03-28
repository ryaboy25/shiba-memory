-- ==========================================================
-- CCB v0.1 -- Instincts, Progress Tracking, Gateway Events, Daily Logs
-- ==========================================================

-- Add instinct to valid memory types
ALTER TABLE memories DROP CONSTRAINT IF EXISTS memories_type_check;
ALTER TABLE memories ADD CONSTRAINT memories_type_check CHECK (type IN (
  'user', 'feedback', 'project', 'reference', 'episode', 'skill', 'instinct'
));

-- Track confidence changes over time for instincts
ALTER TABLE memories ADD COLUMN IF NOT EXISTS confidence_history JSONB DEFAULT '[]';

-- Events queue for gateway (processed by SessionStart hook)
CREATE TABLE IF NOT EXISTS events_queue (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    source          TEXT NOT NULL,          -- 'gateway', 'webhook', 'channel', 'cron'
    event_type      TEXT NOT NULL,          -- 'message', 'reminder', 'alert', 'task'
    payload         JSONB NOT NULL,
    processed       BOOLEAN DEFAULT false,
    processed_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_events_unprocessed ON events_queue (created_at) WHERE NOT processed;

-- Progress trackers stored as project memories with structured metadata
-- No new table needed, we use memories with type='project' and metadata->>'tracker'

-- Daily logs stored as episode memories with tag='daily-log'
-- No new table needed, we use memories with type='episode' and tag

-- Evolve instincts: find high-confidence, frequently-accessed instincts ready to become skills
CREATE OR REPLACE FUNCTION find_evolved_instincts(
    min_confidence FLOAT DEFAULT 0.7,
    min_access INT DEFAULT 3
)
RETURNS TABLE (
    id UUID,
    title TEXT,
    content TEXT,
    confidence FLOAT,
    access_count INT,
    tags TEXT[],
    created_at TIMESTAMPTZ
) AS $$
    SELECT id, title, content, confidence, access_count, tags, created_at
    FROM memories
    WHERE type = 'instinct'
      AND confidence >= min_confidence
      AND access_count >= min_access
    ORDER BY confidence DESC, access_count DESC;
$$ LANGUAGE sql STABLE;

-- Find similar instincts for clustering
CREATE OR REPLACE FUNCTION cluster_instincts(
    target_id UUID,
    similarity_threshold FLOAT DEFAULT 0.7
)
RETURNS TABLE (
    id UUID,
    title TEXT,
    content TEXT,
    similarity FLOAT
) AS $$
    SELECT
        m.id, m.title, m.content,
        1 - (m.embedding::halfvec(512) <=> (SELECT embedding FROM memories WHERE id = target_id)::halfvec(512)) AS similarity
    FROM memories m
    WHERE m.type = 'instinct'
      AND m.id != target_id
      AND m.embedding IS NOT NULL
      AND 1 - (m.embedding::halfvec(512) <=> (SELECT embedding FROM memories WHERE id = target_id)::halfvec(512)) > similarity_threshold
    ORDER BY similarity DESC
    LIMIT 10;
$$ LANGUAGE sql STABLE;
