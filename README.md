# SHB — Second Hermes Brain

A PostgreSQL + pgvector persistent memory system for AI agents. SHB stores memories in a relational database with semantic search, knowledge graphs, and automatic learning — accessible via an HTTP gateway API.

## What It Does

- **Remembers everything** across all sessions, all projects, all repos
- **Searches by meaning** not just keywords (hybrid semantic + full-text search)
- **Builds a knowledge graph** linking related memories automatically
- **Gets smarter over time** with confidence-scored instincts that evolve into skills
- **Ingests external knowledge** from web pages, RSS feeds, git repos, files, AI news
- **Runs an always-on gateway** HTTP API for agent integration
- **Tracks progress** on long-running tasks with JSON feature tracking
- **Keeps daily logs** as transparent, inspectable working memory

## Architecture

```
AI Agent (Hermes / etc.)
    |
    |-- HTTP API (port 18789)
    |
SHB Gateway
    |
    |-- POST /remember -----> Store memories with embeddings
    |-- POST /recall -------> Hybrid semantic + full-text search
    |-- POST /forget -------> Delete by criteria
    |-- GET  /memory/:id ---> Get specific memory
    |-- POST /link ---------> Knowledge graph management
    |-- POST /reflect/* ----> Brain maintenance
    |-- POST /event --------> Event queue
    |-- POST /webhook ------> External integrations
    |
PostgreSQL 16 + pgvector
    |-- memories (embeddings, fts, confidence, decay)
    |-- memory_links (knowledge graph)
    |-- conversations (episodic memory)
    |-- events_queue (gateway events)
    |-- ingestion_sources + log (dedup tracking)
    |-- consolidation_log (brain maintenance)
```

## Quick Start

```bash
git clone https://github.com/ryaboy25/claude-code-brain.git
cd claude-code-brain/cli
npm install && npm run build
cd .. && node cli/dist/index.js setup
```

The setup wizard handles everything:
1. Checks prerequisites (Docker, Node, Ollama)
2. Starts PostgreSQL + pgvector
3. Asks about you (name, role, expertise, preferences)
4. Scans your repos
5. Configures gateway API key
6. Verifies the brain is ready

## Prerequisites

- **Docker** (for PostgreSQL + pgvector)
- **Node.js 18+**
- **Ollama** with `nomic-embed-text` model (for local embeddings, free)

```bash
# Install Ollama (Linux/WSL)
curl -fsSL https://ollama.com/install.sh | sh
ollama serve &
ollama pull nomic-embed-text
```

## Gateway API

The gateway is the primary integration point. Start it with `shb gateway start`.

Auth: Set `SHB_API_KEY` in `.env`, then pass `X-SHB-Key: <key>` header.

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

### Example: Store a memory

```bash
curl -X POST http://localhost:18789/remember \
  -H "Content-Type: application/json" \
  -H "X-SHB-Key: your-key" \
  -d '{"type": "user", "title": "My Role", "content": "Senior engineer at ACME", "importance": 0.9}'
```

### Example: Search memories

```bash
curl -X POST http://localhost:18789/recall \
  -H "Content-Type: application/json" \
  -H "X-SHB-Key: your-key" \
  -d '{"query": "what does the user do", "limit": 5}'
```

## CLI Commands

### Memory

```bash
shb remember -t user --title "My Role" -c "Senior DB engineer at ACME"
shb recall "what does the user do" --limit 5
shb forget --id <uuid>
shb forget --expired
shb forget --low-confidence 0.1
```

### Search

Hybrid search combines semantic similarity (pgvector cosine distance) with PostgreSQL full-text search, weighted by importance, confidence, access frequency, and knowledge graph connections.

```bash
# Basic search
shb recall "database architecture patterns"

# Scoped to a project (project memories get 1.3x boost)
shb recall "auth system" --project /path/to/repo

# Filter by type
shb recall "preferences" --type feedback --limit 3
```

### Knowledge Graph

```bash
shb link create <source-id> <target-id> supports --strength 0.8
shb link show <memory-id>
shb link auto                    # auto-discover relationships
```

### Ingestion

```bash
shb ingest web https://docs.example.com    # web pages
shb ingest rss https://blog.example.com/feed  # RSS feeds
shb ingest git /path/to/repo               # git history
shb ingest file /path/to/notes             # files and directories
shb ingest news                            # AI/tech news feeds
shb ingest news --dry-run                  # preview without storing
```

### Brain Maintenance

```bash
shb reflect stats                # memory statistics
shb reflect consolidate          # merge dupes, detect contradictions, decay, auto-link
shb reflect decay                # reduce confidence of old unused memories
shb reflect duplicates           # find near-duplicates
shb evolve                       # promote instincts to skills
```

### Progress Tracking

```bash
shb track create "my-project" --features "auth" "api" "tests"
shb track update "my-project" "auth" --status done
shb track show
```

### Daily Logs

```bash
shb log add "Implemented the gateway server"
shb log show                     # today
shb log show 2026-03-27          # specific date
shb log recent --days 7
```

### Other

```bash
shb gateway start        # HTTP server on port 18789
shb gateway status
shb gateway stop
shb daemon start         # background consolidation (hourly)
shb health               # verify database and extensions
shb setup                # interactive setup wizard
```

## How the Brain Works

### Vector Search

Every memory is converted to a 512-dimension vector by an embedding model (Ollama nomic-embed-text, running locally). Similar meanings produce nearby vectors. "What does the user do for work" finds "Senior DB engineer" even though they share no words.

The HNSW index stores vectors as halfvec (16-bit) while the data stays full precision (32-bit). This cuts index memory in half with minimal accuracy loss.

### Hybrid Search

Two search arms run in parallel:
1. **Semantic**: pgvector cosine similarity on halfvec(512)
2. **Full-text**: PostgreSQL websearch_to_tsquery on a generated tsvector column

Results are fused with configurable weights (default 70% semantic, 30% keyword), then scored with:
- **ACT-R decay**: frequently accessed memories score higher
- **Confidence**: Bayesian-updated score (reinforced or contradicted over time)
- **Graph boost**: memories with more relationships score higher
- **Project boost**: 1.3x for project-specific memories when querying from that project

### Self-Improving Memory

The brain gets smarter over time:
1. **Instincts** are low-confidence observations captured automatically
2. Instincts gain confidence through repeated access and reinforcement
3. `shb evolve` promotes high-confidence instincts (>0.7, accessed 3+ times) into learned skills
4. `shb reflect consolidate` merges duplicates, detects contradictions, and generates cross-project insights

## Configuration

Copy `.env.example` to `.env` and configure:

```bash
# Database
SHB_DB_HOST=localhost
SHB_DB_PORT=5432
SHB_DB_NAME=shb
SHB_DB_USER=shb
SHB_DB_PASSWORD=shb_dev_password

# Embedding provider: ollama (local, free) or openai (cloud, paid)
SHB_EMBEDDING_PROVIDER=ollama
SHB_OLLAMA_URL=http://localhost:11434
SHB_OLLAMA_MODEL=nomic-embed-text

# Gateway
SHB_GATEWAY_PORT=18789
SHB_GATEWAY_HOST=0.0.0.0
SHB_API_KEY=your-secret-key
```

## Project Structure

```
claude-code-brain/
  docker-compose.yml              # PostgreSQL 16 + pgvector
  schema/
    001_init.sql                  # Core tables, hybrid search, ACT-R scoring
    002_profiles_scoping.sql      # Project scoping, ingestion tracking
    003_instincts_tracking_gateway.sql  # Instincts, events queue
  cli/src/
    index.ts                      # CLI entry
    db.ts                         # PostgreSQL connection pool
    embeddings.ts                 # Ollama / OpenAI / hashtest providers
    commands/
      remember.ts                 # Store with embedding + auto-link
      recall.ts                   # Scoped hybrid search
      forget.ts                   # Delete by criteria
      link.ts                     # Knowledge graph
      reflect.ts                  # Stats, decay, consolidation
      evolve.ts                   # Instinct to skill promotion
      track.ts                    # Progress tracking
      log.ts                      # Daily logs
      gateway.ts                  # HTTP server (primary agent interface)
      daemon.ts                   # Background service
      setup.ts                    # Interactive wizard
      ingest/                     # web, rss, git, file, news
    utils/
      secrets.ts                  # API key masking
      dedup.ts                    # File-backed dedup window
      hash.ts                     # SHA-256
      chunker.ts                  # Text chunking
      project.ts                  # Git root detection
```

## Inspired By

Built after studying these projects:
- [Ogham MCP](https://github.com/ogham-mcp/ogham-mcp) -- hybrid search architecture, halfvec trick, ACT-R scoring
- [Superpowers](https://github.com/obra/superpowers) -- skills-as-markdown, session bootstrap pattern
- [everything-claude-code](https://github.com/affaan-m/everything-claude-code) -- instinct learning system
- [CLAWDBOT](https://github.com/HarleyCoops/CLAWDBOT) -- gateway pattern, daily logs
- [Anthropic Harnesses](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) -- JSON progress tracking, context engineering

## License

MIT
