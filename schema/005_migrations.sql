-- ==========================================================
-- Shiba v0.2 — Migration Tracking
-- ==========================================================

CREATE TABLE IF NOT EXISTS migrations_log (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    filename    TEXT NOT NULL UNIQUE,
    checksum    TEXT NOT NULL,
    applied_at  TIMESTAMPTZ DEFAULT now()
);
