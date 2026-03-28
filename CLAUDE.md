# Claude Code Brain (CCB)

PostgreSQL + pgvector backed persistent memory system for Claude Code.

## Architecture

- **Database**: PostgreSQL 16 + pgvector (Docker)
- **CLI**: TypeScript (`ccb` command) — bridge between Claude Code and the database
- **Skills**: Markdown skill files that teach Claude Code how to use the CLI
- **Hooks**: Claude Code lifecycle hooks for automatic memory capture (planned)

## Key Commands

```bash
ccb remember --type <type> --title "..." --content "..."  # Store
ccb recall "query"                                         # Search
ccb forget --id <uuid>                                     # Delete
ccb reflect stats                                          # Stats
ccb link auto                                              # Auto-link
ccb health                                                 # Health check
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
