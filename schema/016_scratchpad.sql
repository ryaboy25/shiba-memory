-- ==========================================================
-- Shiba v0.3 — Scratchpad (from Mnemosyne)
-- Temporary reasoning workspace separate from persistent memory.
-- Auto-expires after 24 hours.
-- ==========================================================

CREATE TABLE IF NOT EXISTS scratchpad (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    session_id  TEXT NOT NULL,
    user_id     TEXT DEFAULT 'default',
    key         TEXT NOT NULL,
    value       TEXT NOT NULL,
    created_at  TIMESTAMPTZ DEFAULT now(),
    expires_at  TIMESTAMPTZ DEFAULT now() + interval '24 hours'
);

CREATE INDEX IF NOT EXISTS idx_scratchpad_session ON scratchpad (session_id, key);
CREATE INDEX IF NOT EXISTS idx_scratchpad_expires ON scratchpad (expires_at)
    WHERE expires_at IS NOT NULL;
