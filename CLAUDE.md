# Shiba — Persistent Memory for AI Agents

PostgreSQL + pgvector backed persistent memory system for AI agents.

## Architecture

- **Database**: PostgreSQL 16 + pgvector (Docker)
- **CLI**: TypeScript (`shiba` command) — memory management and maintenance
- **Gateway**: HTTP API (port 18789) — how AI agents talk to the brain
- **Hooks**: Native Claude Code hooks for session memory
- **Embeddings**: Ollama (local) or OpenAI for semantic search

## Gateway API

The gateway is the primary integration point for AI agents. Start it with `shiba gateway start`.

```
GET  /health                  # Lightweight health check (no auth)
GET  /status                  # Brain stats + pending events
POST /remember                # Store a memory
POST /recall                  # Hybrid semantic + full-text search
POST /forget                  # Delete by criteria
GET  /memory/:id              # Get a specific memory
DELETE /memory/:id            # Delete a specific memory
POST /link                    # Create relationship between memories
GET  /links/:id               # Get relationships for a memory
POST /link/auto               # Auto-link all memories
POST /reflect/consolidate     # Full brain maintenance
POST /reflect/decay           # Decay old unused memories
POST /event                   # Queue an event
GET  /events                  # Get pending events
POST /events/process          # Mark events as processed
POST /webhook                 # Generic webhook receiver
POST /channel                 # Channel message receiver
```

Auth: Set `SHB_API_KEY` in `.env`, then pass `X-SHB-Key: <key>` header.

## CLI Commands

```bash
shiba remember --type <type> --title "..." --content "..."  # Store
shiba recall "query"                                         # Search
shiba forget --id <uuid>                                     # Delete
shiba reflect stats                                          # Stats
shiba reflect consolidate                                    # Maintenance
shiba link auto                                              # Auto-link
shiba gateway start                                          # Start HTTP API
shiba health                                                 # Health check
```

## Development

```bash
cd cli && npm run dev -- <command>   # Run without building
cd cli && npm run build              # Build
docker compose up -d                 # Start database
docker compose down                  # Stop database
```

## Schema

All search intelligence lives in SQL (hybrid_search function). The schema is at `schema/001_init.sql`.

Key design choices:
- halfvec trick: store as vector(512), index/query as halfvec(512) via HNSW — halves memory
- Generated tsvector column for zero-maintenance full-text search
- ACT-R inspired recall scoring (access frequency + recency decay)
- Bayesian confidence updates
- Knowledge graph via memory_links table
