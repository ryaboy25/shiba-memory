-- ==========================================================
-- Shiba v0.2 — Extraction Tracking
-- Logs all memory extractions across tiers for debugging and cost monitoring
-- ==========================================================

CREATE TABLE IF NOT EXISTS extraction_log (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tier            TEXT NOT NULL CHECK (tier IN ('pattern', 'targeted', 'batch')),
    trigger         TEXT NOT NULL,
    input_hash      TEXT,
    facts_created   INT DEFAULT 0,
    tokens_used     INT DEFAULT 0,
    created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_extraction_log_tier ON extraction_log (tier, created_at DESC);

-- Track extraction tier on memories
ALTER TABLE memories ADD COLUMN IF NOT EXISTS extraction_tier TEXT DEFAULT 'manual';
