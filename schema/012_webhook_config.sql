-- ==========================================================
-- Shiba — Webhook Configuration
-- Register webhook URLs to receive memory event notifications
-- ==========================================================

CREATE TABLE IF NOT EXISTS webhook_subscriptions (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    url         TEXT NOT NULL,
    events      TEXT[] DEFAULT '{"memory.created","memory.updated","memory.deleted"}',
    secret      TEXT,           -- Optional signing secret for verification
    active      BOOLEAN DEFAULT true,
    created_at  TIMESTAMPTZ DEFAULT now()
);
