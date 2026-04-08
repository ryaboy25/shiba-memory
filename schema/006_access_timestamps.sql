-- ==========================================================
-- Shiba v0.2 — Access Timestamps for Proper ACT-R
-- Stores last N access times for power-law decay calculation
-- ==========================================================

-- Add access_timestamps column (JSONB array of epoch floats)
ALTER TABLE memories ADD COLUMN IF NOT EXISTS access_timestamps JSONB DEFAULT '[]';

-- Backfill existing memories with their last_accessed_at (or created_at)
UPDATE memories
SET access_timestamps = jsonb_build_array(
  EXTRACT(EPOCH FROM COALESCE(last_accessed_at, created_at))
)
WHERE access_timestamps = '[]';

-- Replace touch_memory to also track individual access timestamps (keep last 50)
CREATE OR REPLACE FUNCTION touch_memory(mid UUID)
RETURNS void AS $$
  UPDATE memories
  SET access_count = access_count + 1,
      last_accessed_at = now(),
      access_timestamps = (
        SELECT COALESCE(jsonb_agg(v ORDER BY v::text::float DESC), '[]'::jsonb)
        FROM (
          SELECT v FROM jsonb_array_elements(access_timestamps) v
          ORDER BY v::text::float DESC
          LIMIT 49
        ) sub
      ) || jsonb_build_array(EXTRACT(EPOCH FROM now()))
  WHERE id = mid;
$$ LANGUAGE sql;
