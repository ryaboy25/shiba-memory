# Shiba Memory Plugin for Hermes Agent

Persistent memory for Hermes that learns and never forgets.

## Install

```bash
# Symlink the plugin into Hermes (stays in sync with git pulls)
ln -s $(pwd)/plugins/hermes ~/.hermes/plugins/shiba

# Install dependency
pip install httpx
```

## Setup

1. Make sure Shiba's gateway is running:
   ```bash
   cd /path/to/shiba-memory
   docker compose up -d
   shiba gateway start
   ```

2. Configure in Hermes:
   ```bash
   hermes memory setup
   # Select "shiba" as provider
   # Enter gateway URL (default: http://localhost:18789)
   # Enter API key if configured
   ```

   Or create `~/.hermes/plugins/shiba/config.json` manually:
   ```json
   {
     "endpoint": "http://localhost:18789",
     "api_key": "",
     "project": ""
   }
   ```

3. Launch Hermes — Shiba loads automatically.

## What Hermes Gets

**Tools:**
- `shiba_recall` — Hybrid semantic + full-text search across all memories
- `shiba_remember` — Store memories with auto-embedding and knowledge graph linking
- `shiba_forget` — Delete memories by ID

**Automatic behaviors:**
- **Prefetch**: Relevant memories injected before each turn
- **Sync turn**: Conversations automatically persisted as episodes (7-day TTL)
- **Pre-compress**: Context snapshot saved before Hermes compresses history
- **Session end**: Summary stored when conversation closes
- **Memory mirror**: Built-in MEMORY.md/USER.md writes mirrored to Shiba

## Memory Types

| Type | When to use |
|------|-------------|
| `user` | Identity, preferences, expertise |
| `feedback` | Corrections and confirmations |
| `project` | Goals, decisions, context |
| `reference` | Pointers to external resources |
| `skill` | Learned procedures |
| `instinct` | Low-confidence observations (auto-evolve to skills) |
