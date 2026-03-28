# Claude Code Brain (CCB)

A PostgreSQL + pgvector persistent memory system that gives Claude Code a real brain. Instead of flat markdown files that get truncated at 200 lines, CCB stores memories in a relational database with semantic search, knowledge graphs, and automatic learning.

CCB extends Claude Code. It does not replace it. Claude Code stays as the orchestrator. CCB gives it long-term memory, external knowledge ingestion, and an always-on gateway server.

## What It Does

- **Remembers everything** across all sessions, all projects, all repos
- **Auto-learns** from every Claude Code session via lifecycle hooks
- **Searches by meaning** not just keywords (hybrid semantic + full-text search)
- **Builds a knowledge graph** linking related memories automatically
- **Gets smarter over time** with confidence-scored instincts that evolve into skills
- **Ingests external knowledge** from web pages, RSS feeds, git repos, files, AI news
- **Runs an always-on gateway** so the brain is accessible even without Claude Code open
- **Tracks progress** on long-running tasks with JSON feature tracking
- **Keeps daily logs** as transparent, inspectable working memory

## Architecture

```
Claude Code (orchestrator)
    |
    |-- SessionStart hook -----> ccb recall (inject context)
    |-- PostToolUse hook ------> ccb remember (auto-capture)
    |-- PreCompact hook -------> ccb remember (flush before compression)
    |-- PostCompact hook ------> ccb recall (re-inject after compression)
    |-- Stop hook -------------> ccb log (track session)
    |
ccb CLI
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
5. Installs Claude Code hooks
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

## Commands

### Memory

```bash
ccb remember -t user --title "My Role" -c "Senior DB engineer at ACME"
ccb recall "what does the user do" --limit 5
ccb forget --id <uuid>
ccb forget --expired
ccb forget --low-confidence 0.1
```

### Search

Hybrid search combines semantic similarity (pgvector cosine distance) with PostgreSQL full-text search, weighted by importance, confidence, access frequency, and knowledge graph connections.

```bash
# Basic search
ccb recall "database architecture patterns"

# Scoped to a project (project memories get 1.3x boost)
ccb recall "auth system" --project /path/to/repo

# Filter by type
ccb recall "preferences" --type feedback --limit 3
```

### Knowledge Graph

```bash
ccb link create <source-id> <target-id> supports --strength 0.8
ccb link show <memory-id>
ccb link auto                    # auto-discover relationships
```

### Ingestion

```bash
ccb ingest web https://docs.example.com    # web pages
ccb ingest rss https://blog.example.com/feed  # RSS feeds
ccb ingest git /path/to/repo               # git history
ccb ingest file /path/to/notes             # files and directories
ccb ingest news                            # AI/tech news feeds
ccb ingest news --dry-run                  # preview without storing
```

### Brain Maintenance

```bash
ccb reflect stats                # memory statistics
ccb reflect consolidate          # merge dupes, detect contradictions, decay, auto-link
ccb reflect decay                # reduce confidence of old unused memories
ccb reflect duplicates           # find near-duplicates
ccb evolve                       # promote instincts to skills
```

### Progress Tracking

```bash
ccb track create "my-project" --features "auth" "api" "tests"
ccb track update "my-project" "auth" --status done
ccb track show
```

### Daily Logs

```bash
ccb log add "Implemented the gateway server"
ccb log show                     # today
ccb log show 2026-03-27          # specific date
ccb log recent --days 7
```

### Gateway (Always-On Server)

```bash
ccb gateway start                # HTTP server on port 18789
ccb gateway status
ccb gateway stop

# API endpoints:
# GET  /status          - brain stats + pending events
# POST /remember        - store a memory from any source
# POST /recall          - search memories
# POST /event           - queue an event for next session
# GET  /events          - list pending events
# POST /events/process  - mark events as processed
```

### Hooks

```bash
ccb hooks install       # wire into Claude Code settings.json
ccb hooks status        # check which hooks are active
ccb hooks uninstall     # remove hooks
```

### Other

```bash
ccb daemon start        # background consolidation (hourly)
ccb health              # verify database and extensions
ccb setup               # interactive setup wizard
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

### Lifecycle Hooks

Five hooks fire automatically during Claude Code sessions:

| Hook | When | What It Does |
|------|------|-------------|
| SessionStart | Session begins | Injects relevant memories as context |
| PostToolUse | After Edit/Write/Bash | Auto-captures meaningful actions |
| PreCompact | Before context compression | Flushes important context to DB |
| PostCompact | After compression | Re-injects memories into fresh context |
| Stop | Session ends | Logs conversation to daily log |

### Self-Improving Memory

The brain gets smarter over time:
1. **Instincts** are low-confidence observations captured automatically
2. Instincts gain confidence through repeated access and reinforcement
3. `ccb evolve` promotes high-confidence instincts (>0.7, accessed 3+ times) into learned skills
4. `ccb reflect consolidate` merges duplicates, detects contradictions, and generates cross-project insights

## Configuration

Copy `.env.example` to `.env` and configure:

```bash
# Database
CCB_DB_HOST=localhost
CCB_DB_PORT=5432
CCB_DB_NAME=ccb
CCB_DB_USER=ccb
CCB_DB_PASSWORD=ccb_dev_password

# Embedding provider: ollama (local, free) or openai (cloud, paid)
CCB_EMBEDDING_PROVIDER=ollama
CCB_OLLAMA_URL=http://localhost:11434
CCB_OLLAMA_MODEL=nomic-embed-text

# Gateway port
CCB_GATEWAY_PORT=18789
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
    index.ts                      # CLI entry (15 commands)
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
      gateway.ts                  # HTTP server
      hooks.ts                    # Hook installer
      daemon.ts                   # Background service
      setup.ts                    # Interactive wizard
      ingest/                     # web, rss, git, file, news
    hooks/
      session-start.ts            # Context injection
      post-tool.ts                # Auto-capture with filtering
      pre-compact.ts              # Pre-compaction flush
      post-compact.ts             # Post-compaction re-injection
      stop.ts                     # Session tracking
    utils/
      secrets.ts                  # API key masking
      dedup.ts                    # File-backed dedup window
      hash.ts                     # SHA-256
      chunker.ts                  # Text chunking
      project.ts                  # Git root detection
  skills/
    remember.md                   # /remember skill
    recall.md                     # /recall skill
    forget.md                     # /forget skill
    reflect.md                    # /reflect skill
    ingest.md                     # /ingest skill
    jarvis.md                     # Master orchestration skill
```

## Inspired By

Built after studying these projects:
- [Ogham MCP](https://github.com/ogham-mcp/ogham-mcp) -- hybrid search architecture, halfvec trick, ACT-R scoring
- [Superpowers](https://github.com/obra/superpowers) -- skills-as-markdown, session bootstrap pattern
- [everything-claude-code](https://github.com/affaan-m/everything-claude-code) -- instinct learning system, hook lifecycle
- [CLAWDBOT](https://github.com/HarleyCoops/CLAWDBOT) -- gateway pattern, daily logs, pre-compaction flush
- [Anthropic Harnesses](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) -- JSON progress tracking, context engineering

## License

MIT
