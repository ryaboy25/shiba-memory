-- ==========================================================
-- Shiba v0.3 — Explicit Conflict State (from Brainstack)
-- Tracks open/resolved contradictions instead of just links
-- ==========================================================

ALTER TABLE memory_links ADD COLUMN IF NOT EXISTS conflict_status TEXT DEFAULT NULL
  CHECK (conflict_status IN ('open', 'resolved', NULL));
ALTER TABLE memory_links ADD COLUMN IF NOT EXISTS resolution TEXT;
ALTER TABLE memory_links ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;
