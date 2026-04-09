-- ==========================================================
-- Shiba — Temporal Metadata
-- Stores what time period a memory refers to (not just when stored).
-- Enables temporal reasoning: "what did we decide last week?"
-- ==========================================================

-- What time period does this memory refer to?
-- e.g., a decision made on 2026-03-15 might be stored on 2026-04-08
ALTER TABLE memories ADD COLUMN IF NOT EXISTS temporal_ref TIMESTAMPTZ;

-- Index for temporal queries
CREATE INDEX IF NOT EXISTS idx_memories_temporal_ref ON memories (temporal_ref DESC)
    WHERE temporal_ref IS NOT NULL;

-- Update scoped_recall to include temporal_ref in output
-- (The function already returns created_at; temporal_ref is available via metadata
--  or can be added to the RETURNS TABLE in a future migration)
