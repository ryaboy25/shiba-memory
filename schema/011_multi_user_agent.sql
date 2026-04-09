-- ==========================================================
-- Shiba — Multi-User & Multi-Agent Isolation
-- Memories scoped per user and per agent. Different users
-- on the same instance see only their own memories.
-- ==========================================================

ALTER TABLE memories ADD COLUMN IF NOT EXISTS user_id TEXT DEFAULT 'default';
ALTER TABLE memories ADD COLUMN IF NOT EXISTS agent_id TEXT DEFAULT 'default';

CREATE INDEX IF NOT EXISTS idx_memories_user ON memories (user_id);
CREATE INDEX IF NOT EXISTS idx_memories_agent ON memories (agent_id);
CREATE INDEX IF NOT EXISTS idx_memories_user_agent ON memories (user_id, agent_id);

-- Also add to conversations for session scoping
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS user_id TEXT DEFAULT 'default';
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS agent_id TEXT DEFAULT 'default';
