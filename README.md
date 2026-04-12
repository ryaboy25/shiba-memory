# Shiba Memory

> Persistent, self-improving memory for AI agents that never forgets — 34ms hybrid retrieval, native Claude Code + Hermes support, fully local and open source.

Shiba stores memories with hybrid semantic + full-text search, ACT-R-inspired cognitive scoring, and tiered extraction that learns from every session — accessible via CLI, HTTP gateway, Python SDK, or native agent hooks.

**Framework-agnostic**: works with Claude Code, Hermes, LangChain, custom agents, or anything that speaks HTTP.

## Why Shiba?

| Feature | Shiba | Mem0 | Zep | Letta | ByteRover |
|---------|-----|------|-----|-------|-----------|
| Hybrid search (semantic + FTS) | **Yes** | Vector (graph in Pro) | Graph+semantic | Agent-managed | File-based |
| Self-improving memory (instinct→skill) | **Yes** | No | No | LLM-managed | No |
| Write-time deduplication | **Yes** | Yes | Yes | No | No |
| Multi-user / multi-agent isolation | **Yes** | Yes | Yes | Yes | No |
| Tiered extraction (free + LLM) | **Yes** | LLM only | LLM only | LLM only | No |
| ACT-R-inspired scoring (fast + proper) | **Yes** | No | No | No | No |
| False Memory Resistance (HaluMem) | **90.7%** | ~65% | — | — | — |
| Self-hosted & open source | **Yes** | Yes | Partial | Yes | Yes |
| Claude Code hooks | **Native** | No | No | No | No |
| Hermes agent plugin | **Native** | No | No | No | No |
| Python SDK | **Yes** | Yes | Yes | Yes | No |
| Session management API | **Yes** | Yes | Yes | Yes | No |
| Webhook subscriptions | **Yes** | No | No | No | No |
| LongMemEval score | **50.2%** | 49.0% | 63.8% | — | — |

_HaluMem-Medium: 20 users, 12,300 memory points, 2,648 interference points. Full results in [`benchmarks/`](benchmarks/)._

## What It Does

- **Remembers everything** across all sessions, all projects, all repos
- **Searches by meaning** not just keywords (hybrid semantic + full-text search)
- **Links related memories** via a relationship adjacency list (6 relation types)
- **Gets smarter over time** with confidence-scored instincts that evolve into skills
- **Ingests external knowledge** from web pages, RSS feeds, git repos, files, AI news
- **Runs an always-on gateway** HTTP API for any agent integration
- **Integrates with Claude Code** via native hooks (session start, tool use, compaction)
- **Tracks progress** on long-running tasks with JSON feature tracking
- **Keeps daily logs** as transparent, inspectable working memory

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  AI Agents                                                  │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────┐   │
│  │ Claude   │ │ Hermes   │ │ LangChain│ │ Custom Agent │   │
│  │ Code     │ │          │ │          │ │              │   │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘ └──────┬───────┘   │
│       │ hooks      │ HTTP       │ HTTP          │ HTTP      │
├───────┴────────────┴────────────┴───────────────┴───────────┤
│  Shiba Gateway API (port 18789)                             │
│  17 REST endpoints · Auth via X-Shiba-Key · Event queue       │
├─────────────────────────────────────────────────────────────┤
│  Shiba CLI (TypeScript)                                     │
│  48+ commands · remember · recall · forget · evolve · ingest│
├─────────────────────────────────────────────────────────────┤
│  PostgreSQL 16 + pgvector                                   │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────┐   │
│  │ memories │ │ memory   │ │conversa- │ │ events_queue │   │
│  │ +vectors │ │ _links   │ │ tions    │ │              │   │
│  │ +fts     │ │ (graph)  │ │(episodic)│ │ (webhooks)   │   │
│  └──────────┘ └──────────┘ └──────────┘ └──────────────┘   │
│  HNSW halfvec index · 17 SQL functions · hybrid search      │
└─────────────────────────────────────────────────────────────┘
```

## Quick Start

### Prerequisites

- **Docker** (for PostgreSQL + pgvector)
- **Node.js 18+**
- **An embedding provider** (see options below)

### Install

```bash
git clone https://github.com/ryaboy25/shiba-memory.git
cd shiba-memory

# Create .env from template
cp .env.example .env

# Start PostgreSQL + pgvector
docker compose up -d postgres

# Build the CLI
cd cli && npm install && npm run build

# Run the setup wizard
node dist/index.js setup

# Start the gateway
node dist/index.js gateway start
```

### Embedding Providers

Choose one. All produce vectors stored in PostgreSQL with pgvector.

#### Option 1: Ollama (easiest, no GPU required)

```bash
curl -fsSL https://ollama.com/install.sh | sh
ollama pull nomic-embed-text
```

Default config — works out of the box. `nomic-embed-text` has 8192-token context (no truncation issues) and 768 dims (padded to 1024).

#### Option 2: Sentence-Transformers Server (best quality, GPU recommended)

```bash
pip install sentence-transformers fastapi uvicorn
CUDA_VISIBLE_DEVICES=0 uvicorn tools.embed_server:app --port 8090 &
```

Then set in `.env`:
```
SHB_EMBEDDING_PROVIDER=tei
SHB_TEI_URL=http://localhost:8090
```

Uses `mxbai-embed-large-v1` by default (1024 native dims). GPU-accelerated, handles long texts natively via sentence-transformers tokenization, and supports batching. The `embed_server.py` script is a lightweight FastAPI wrapper (~25 lines).

**Note:** If using HuggingFace TEI Docker instead, your GPU must have a compatible compute capability (Ampere 8.x works, Blackwell 12.x does not yet). The sentence-transformers server works with any GPU that PyTorch supports.

#### Option 3: OpenAI API (no local GPU needed)

Set in `.env`:
```
SHB_EMBEDDING_PROVIDER=openai
SHB_OPENAI_API_KEY=sk-...
SHB_OPENAI_MODEL=text-embedding-3-small
```

### Verify

```bash
curl http://localhost:18789/health
# → {"status":"ok","uptime_seconds":5,"db_latency_ms":2}
```

## Hermes Agent Integration

Shiba ships as a native Hermes memory provider plugin.

### Setup

```bash
# From the shiba-memory repo root:
mkdir -p ~/.hermes/hermes-agent/plugins/memory/shiba
ln -s $(pwd)/plugins/hermes/* ~/.hermes/hermes-agent/plugins/memory/shiba/

# Install dependency in Hermes venv
~/.hermes/hermes-agent/venv/bin/pip install httpx

# Configure
hermes memory setup
# → Select "shiba", enter gateway URL (default: http://localhost:18789)
```

### What Hermes Gets

- **shiba_recall** / **shiba_remember** / **shiba_forget** tools available to the LLM
- **Automatic memory**: Every conversation turn stored as an episode via `sync_turn()`
- **Tier 1 extraction**: Pattern matching on user messages ("I prefer...", "Don't...", "Remember that...")
- **Tier 2 extraction**: LLM-based correction detection and session summarization
- **Prefetch**: Relevant memories injected before each turn
- **Session summaries**: Key insights extracted when sessions end
- **Memory mirroring**: Built-in MEMORY.md/USER.md writes mirrored to Shiba

### Verify

```bash
# In Hermes, say something memorable:
# → "Remember that I prefer PostgreSQL for all databases"

# Then check the DB:
docker exec shiba-postgres psql -U shb -d shb \
  -c "SELECT type, title FROM memories ORDER BY created_at DESC LIMIT 5;"
```

## Claude Code Integration

Shiba ships with native Claude Code hooks that provide persistent memory across sessions.

### How It Works

| Hook | When It Fires | What Shiba Does |
|------|---------------|---------------|
| **SessionStart** | New session begins | Recalls relevant project memories, user preferences, feedback, and skills → injects into context |
| **PostToolUse** | After Edit/Write/Bash | Captures significant actions as episodic memories (7-day TTL) |
| **Stop** | Response finishes | Updates session record, cleans up old episodes |
| **PreCompact** | Before context compression | Snapshots current decisions and files touched before context is lost |
| **PostCompact** | After context compression | Re-injects key project context and user feedback into compressed context |

### Setup

The hooks are configured in `~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [{
      "matcher": "",
      "hooks": [{
        "type": "command",
        "command": "node \"/path/to/shiba-memory/cli/dist/hooks/session-start.js\"",
        "timeout": 5
      }]
    }],
    "PostToolUse": [{
      "matcher": "Edit|Write|Bash",
      "hooks": [{
        "type": "command",
        "command": "node \"/path/to/shiba-memory/cli/dist/hooks/post-tool.js\"",
        "timeout": 5
      }]
    }],
    "Stop": [{
      "matcher": "",
      "hooks": [{
        "type": "command",
        "command": "node \"/path/to/shiba-memory/cli/dist/hooks/stop.js\"",
        "timeout": 5
      }]
    }],
    "PreCompact": [{
      "matcher": "",
      "hooks": [{
        "type": "command",
        "command": "node \"/path/to/shiba-memory/cli/dist/hooks/pre-compact.js\"",
        "timeout": 5
      }]
    }],
    "PostCompact": [{
      "matcher": "",
      "hooks": [{
        "type": "command",
        "command": "node \"/path/to/shiba-memory/cli/dist/hooks/post-compact.js\"",
        "timeout": 5
      }]
    }]
  }
}
```

Replace `/path/to/shiba-memory` with your actual install path.

### What You Get

- **Session continuity**: Start a new Claude Code session and Shiba automatically injects relevant context from past sessions
- **Automatic memory**: Every significant edit, file creation, and command is captured
- **Compaction resilience**: When Claude Code compresses your conversation, Shiba re-injects the important stuff
- **Cross-project learning**: Patterns discovered in one project surface when relevant in another

## Gateway API (Framework-Agnostic)

The gateway is the primary integration point for **any** AI agent. Start it with `shiba gateway start`.

Auth: Set `SHB_API_KEY` in `.env`, then pass `X-Shiba-Key: <key>` header.

### Endpoints

```
# Core Memory
POST /remember                # Store a memory (supports extract, auto_importance flags)
POST /recall                  # Hybrid semantic + full-text search
POST /forget                  # Delete by criteria
GET  /memory/:id              # Get a specific memory
DELETE /memory/:id            # Delete a specific memory

# Knowledge Graph
POST /link                    # Create relationship between memories
GET  /links/:id               # Get relationships for a memory
POST /link/auto               # Auto-link all memories

# Sessions
POST /sessions                # Create a session
GET  /sessions                # List sessions (filter by user_id)
GET  /sessions/:id            # Get session with associated memories
POST /sessions/:id/end        # End a session

# Extraction (Tiered)
POST /extract/patterns        # Tier 1: regex-based fact extraction (free)
POST /extract/correction      # Tier 2: LLM correction detection
POST /extract/summarize       # Tier 2: LLM session summarization
POST /extract/preferences     # Tier 2: LLM implicit preference inference

# Webhooks
POST /webhooks/subscribe      # Register a webhook URL
GET  /webhooks                # List webhook subscriptions
DELETE /webhooks/:id          # Remove a webhook

# Graph (Dashboard)
GET  /graph/nodes             # All memories for visualization
GET  /graph/edges             # All memory links for visualization

# Maintenance
POST /reflect/consolidate     # Full brain maintenance
POST /reflect/decay           # Decay old unused memories

# Events
POST /event                   # Queue an event
GET  /events                  # Get pending events
POST /events/process          # Mark events as processed
POST /webhook                 # Generic webhook receiver
POST /channel                 # Channel message receiver

# System
GET  /health                  # Health check + DB latency
GET  /status                  # Brain stats
GET  /metrics                 # Prometheus-compatible metrics
GET  /openapi.json            # OpenAPI spec
```

### Integration Examples

**Python (any agent)**:
```bash
pip install httpx  # or: cd sdks/python && pip install -e .
```

```python
from shiba_memory import Shiba

shiba = Shiba("http://localhost:18789", user_id="ilya")

# Store
shiba.remember("user", "My Role", "Senior engineer at ACME", auto_importance=True)

# Search
results = shiba.recall("what does the user do", limit=5)

# Store with auto-extraction
shiba.remember("episode", "Chat", "I prefer PostgreSQL and always use TypeScript", extract=True)

# Sessions
shiba.create_session("session-123")
shiba.end_session("session-123")
```

**JavaScript/TypeScript (any agent)**:
```typescript
const SHIBA = "http://localhost:18789";
const headers = { "Content-Type": "application/json", "X-Shiba-Key": "your-key" };

// Store
await fetch(`${SHIBA}/remember`, {
  method: "POST", headers,
  body: JSON.stringify({ type: "feedback", title: "Coding Style", content: "User prefers functional patterns" })
});

// Search
const { memories } = await fetch(`${SHIBA}/recall`, {
  method: "POST", headers,
  body: JSON.stringify({ query: "coding preferences", limit: 5 })
}).then(r => r.json());
```

**cURL**:
```bash
# Store
curl -X POST http://localhost:18789/remember \
  -H "Content-Type: application/json" \
  -H "X-Shiba-Key: your-key" \
  -d '{"type": "user", "title": "My Role", "content": "Senior engineer at ACME", "importance": 0.9}'

# Search
curl -X POST http://localhost:18789/recall \
  -H "Content-Type: application/json" \
  -H "X-Shiba-Key: your-key" \
  -d '{"query": "what does the user do", "limit": 5}'
```

## CLI Commands

### Memory

```bash
shiba remember -t user --title "My Role" -c "Senior DB engineer at ACME"
shiba recall "what does the user do" --limit 5
shiba forget --id <uuid>
shiba forget --expired
shiba forget --low-confidence 0.1
```

### Search

Hybrid search combines semantic similarity (pgvector cosine distance) with PostgreSQL full-text search, weighted by importance, confidence, access frequency, and knowledge graph connections.

```bash
# Basic search
shiba recall "database architecture patterns"

# Scoped to a project (project memories get 1.3x boost)
shiba recall "auth system" --project /path/to/repo

# Filter by type
shiba recall "preferences" --type feedback --limit 3
```

### Knowledge Graph

```bash
shiba link create <source-id> <target-id> supports --strength 0.8
shiba link show <memory-id>
shiba link auto                    # auto-discover relationships
```

### Ingestion

```bash
shiba ingest web https://docs.example.com    # web pages
shiba ingest rss https://blog.example.com/feed  # RSS feeds
shiba ingest git /path/to/repo               # git history
shiba ingest file /path/to/notes             # files and directories
shiba ingest news                            # AI/tech news feeds
shiba ingest news --dry-run                  # preview without storing
```

### Brain Maintenance

```bash
shiba reflect stats                # memory statistics
shiba reflect consolidate          # merge dupes, detect contradictions, decay, auto-link
shiba reflect decay                # reduce confidence of old unused memories
shiba reflect duplicates           # find near-duplicates
shiba evolve                       # promote instincts to skills
```

### Progress Tracking

```bash
shiba track create "my-project" --features "auth" "api" "tests"
shiba track update "my-project" "auth" --status done
shiba track show
```

### Daily Logs

```bash
shiba log add "Implemented the gateway server"
shiba log show                     # today
shiba log show 2026-03-27          # specific date
shiba log recent --days 7
```

### Other

```bash
shiba gateway start        # HTTP server on port 18789
shiba gateway status
shiba gateway stop
shiba daemon start         # background consolidation (hourly)
shiba health               # verify database and extensions
shiba setup                # interactive setup wizard
```

## How the Brain Works

### Memory Types

| Type | Purpose | Example |
|------|---------|---------|
| `user` | Identity, preferences, expertise | "Senior engineer who prefers functional patterns" |
| `feedback` | Corrections and confirmations | "Don't mock the database in integration tests" |
| `project` | Goals, decisions, context | "Auth rewrite driven by compliance requirements" |
| `reference` | Pointers to external resources | "Pipeline bugs tracked in Linear project INGEST" |
| `episode` | Session events, conversations | "Edited auth.ts, ran test suite" |
| `skill` | Learned procedures and patterns | "Cross-project pattern: always use parameterized queries" |
| `instinct` | Low-confidence observations | "User seems to prefer small PRs" (evolves to skill) |

### Hybrid Search Scoring

Five retrieval channels fused via Reciprocal Rank Fusion (RRF):
1. **Semantic**: pgvector cosine similarity on halfvec(1024) HNSW index
2. **Full-text**: PostgreSQL websearch_to_tsquery on a generated tsvector column
3. **Temporal**: Date-range filtering for time-based queries
4. **Entity graph**: Memory-entity relationships for entity-focused queries
5. **Substring match**: ILIKE fallback for exact keyword matches

Each channel ranks results independently, then RRF combines them: `score = SUM(1/(60+rank))`. Final scoring applies:

```
final_score = base_score
  x actr_factor        # Access frequency/recency (see below)
  x confidence          # Bayesian confidence score [0.025 - 0.975]
  x graph_boost         # 1 + (sum of link strengths x 0.2)
  x project_boost       # 1.3x for same-project memories
  x recency_boost       # Optional: exponential decay on created_at
```

**ACT-R-Inspired Scoring** (two modes):

- **Fast mode** (default): `1 + ln(access_count + 1) x 0.1` — logarithmic frequency approximation. Good enough for most uses, very fast.
- **Proper mode**: `1 + B_i x 0.1` where `B_i = ln(Σ t_j^(-0.5))` — real ACT-R base-level activation using individual access timestamps with power-law decay. More accurate for memories with varied access patterns, but requires JSONB array scanning.

The fast mode captures the *frequency* component of ACT-R. The proper mode adds the *recency* component — recently accessed memories get a stronger boost than old accesses, following the power-law decay observed in human memory.

### Knowledge Graph

Shiba maintains a relationship adjacency list between memories with 6 relation types: `related`, `supports`, `contradicts`, `supersedes`, `caused_by`, `derived_from`. Links have strength weights (0-1) that boost relevance in search.

Current limitations: `auto_link_memory` only creates `related` links via embedding similarity. Contradiction detection uses embedding dissimilarity as a proxy. This is a flat adjacency list, not a full graph database — no multi-hop traversal or path finding.

### Self-Improving Memory

The brain gets smarter over time:
1. **Instincts** are low-confidence observations captured automatically
2. Instincts gain confidence through repeated access and reinforcement
3. `shiba evolve` promotes high-confidence instincts (>0.7, accessed 3+ times) into learned skills
4. `shiba reflect consolidate` merges duplicates, detects contradictions, and generates cross-project insights

### Halfvec Optimization

Embeddings are stored at full 32-bit precision but indexed as 16-bit halfvec. The HNSW index uses half the memory with negligible accuracy loss — verified across 1024 dimensions with mxbai-embed-large-v1.

## Benchmarks

### LongMemEval Results (500 questions, oracle split)

| System | Score | Judge Model | Embedding | Self-hosted |
|--------|-------|-------------|-----------|-------------|
| **Shiba** | **50.2%** | Gemma 4 26B Q3 (local) | nomic-embed-text (local) | **Yes** |
| Mem0 | 49.0% | GPT-4o (cloud) | OpenAI (cloud) | Partial |
| Zep | 63.8% | GPT-4o (cloud) | OpenAI (cloud) | No |
| Honcho | 89.9% | GPT-4o (cloud) | OpenAI (cloud) | Yes |

**By question type:**

| Category | Shiba | Notes |
|----------|-------|-------|
| Single-session-user | **78.6%** | Best category — user-stated facts |
| Single-session-assistant | **58.9%** | Assistant-generated content |
| Knowledge-update | **53.8%** | Fact changes over time |
| Multi-session | **51.1%** | Cross-session reasoning |
| Temporal-reasoning | 36.1% | Time-based queries |
| Single-session-preference | 16.7% | Implicit preferences (improving) |

**Shiba beats Mem0 (50.2% vs 49.0%) while running entirely locally** with no cloud dependencies. Mem0, Zep, and Honcho all use GPT-4o as judge, which is a significantly stronger evaluator than the local Gemma 4 26B Q3. With a cloud judge, Shiba's score would likely be higher.

**Retrieval latency:** 34ms avg — faster than all competitors.

### Running Benchmarks

```bash
cd benchmarks
pip install psycopg2-binary httpx python-dotenv numpy datasets

# Raw retrieval benchmark
python3 run_longmemeval.py

# LLM-as-judge benchmark (requires llama.cpp or similar at localhost:8080)
python3 run_longmemeval_judge.py
```

### Benchmark Datasets

| Benchmark | What It Tests | Source |
|-----------|---------------|--------|
| **LongMemEval** (ICLR 2025) | Information extraction, knowledge updates, temporal reasoning, abstention | [GitHub](https://github.com/xiaowu0162/LongMemEval) |
| **LoCoMo** (ACL 2024) | Single-hop, multi-hop, temporal, adversarial QA | [HuggingFace](https://huggingface.co/datasets/Aman279/Locomo) |
| **HaluMem** | Memory hallucination: false memory resistance | [GitHub](https://github.com/MemTensor/HaluMem) |

The benchmark adapter (`benchmarks/shiba_adapter.py`) implements a standard interface compatible with mem-bench, allowing direct comparison with Mem0, Zep, Letta, and others.

## Configuration

Copy `.env.example` to `.env` and customize. See `.env.example` for all available options with detailed comments. Key settings:

```bash
# Database
SHB_DB_HOST=localhost
SHB_DB_PORT=5432
SHB_DB_NAME=shb
SHB_DB_USER=shb
SHB_DB_PASSWORD=shb_dev_password

# Embedding provider: 'ollama' (default), 'tei', or 'openai'
SHB_EMBEDDING_PROVIDER=ollama
SHB_EMBED_DIMENSIONS=1024

# LLM provider for extraction: 'openai-compatible', 'ollama', 'anthropic', 'none'
SHB_LLM_PROVIDER=none

# Gateway
SHB_GATEWAY_PORT=18789
SHB_API_KEY=your-secret-key
```

## Project Structure

```
shiba-memory/
  docker-compose.yml              # PostgreSQL 16 + pgvector
  schema/
    001_init.sql                  # Core tables, hybrid search, scoring
    002_profiles_scoping.sql      # Project scoping, ingestion tracking
    003_instincts_tracking_gateway.sql  # Instincts, events queue
    004_temporal_scoring.sql      # Recency boost in scoped_recall
    005_migrations.sql            # Migration tracking table
    006_access_timestamps.sql     # Individual access times for ACT-R
    007_actr_proper.sql           # Proper ACT-R base-level activation
  cli/src/
    index.ts                      # CLI entry (50+ commands)
    db.ts                         # PostgreSQL pool + withTransaction helper
    embeddings.ts                 # Ollama / TEI / OpenAI / hashtest providers
    llm.ts                        # LLM provider layer (openai-compatible, ollama, anthropic, none)
    commands/
      remember.ts                 # Store with embedding + auto-link
      recall.ts                   # Scoped hybrid search
      forget.ts                   # Delete by criteria
      link.ts                     # Knowledge graph (adjacency list)
      reflect.ts                  # Stats, decay, consolidation (transactional)
      evolve.ts                   # Instinct to skill promotion
      track.ts                    # Progress tracking
      log.ts                      # Daily logs
      gateway.ts                  # Hono HTTP server + zod validation + rate limiting
      migrate.ts                  # Schema migration runner
      daemon.ts                   # Background service
      setup.ts                    # Interactive wizard
      ingest/                     # web, rss, git, file, news
    hooks/
      common.ts                   # Gateway-first API client (fallback to direct DB)
      session-start.ts            # SessionStart hook
      post-tool.ts                # PostToolUse hook
      stop.ts                     # Stop hook
      pre-compact.ts              # PreCompact hook
      post-compact.ts             # PostCompact hook
    __tests__/
      gateway.integration.test.ts # 26 HTTP endpoint tests
      edge-cases.test.ts          # 12 validation + security tests
      hooks.test.ts               # Hook utility tests
      reflect.test.ts             # Consolidation tests
      memory.test.ts              # Core CRUD tests
      db.test.ts                  # Schema smoke tests
      utils.test.ts               # Utility tests
    utils/
      secrets.ts                  # API key masking
      dedup.ts                    # File-backed dedup window
      hash.ts                     # SHA-256
      chunker.ts                  # Text chunking
      project.ts                  # Git root detection
  tools/
    embed_server.py               # Lightweight GPU embedding server (sentence-transformers + FastAPI)
    import_claude_to_shiba.py     # Import Claude conversation exports
    reextract_facts.py            # Batch re-extraction of facts from episodes
  benchmarks/
    shiba_adapter.py              # Benchmark adapter for LongMemEval/LoCoMo
    run_longmemeval.py            # Raw retrieval benchmark
    run_longmemeval_judge.py      # LLM-as-judge benchmark
    run_benchmarks.sh             # Runner script
    pyproject.toml                # Python dependencies
  plugins/
    hermes/                       # Hermes agent memory provider plugin
  sdks/
    python/                       # Python SDK (pip install shiba-memory)
```

## Inspired By

Built after studying these projects:
- [Ogham MCP](https://github.com/ogham-mcp/ogham-mcp) — hybrid search architecture, halfvec trick, ACT-R scoring
- [Superpowers](https://github.com/obra/superpowers) — skills-as-markdown, session bootstrap pattern
- [everything-claude-code](https://github.com/affaan-m/everything-claude-code) — instinct learning system
- [CLAWDBOT](https://github.com/HarleyCoops/CLAWDBOT) — gateway pattern, daily logs
- [Anthropic Harnesses](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) — JSON progress tracking, context engineering

## Roadmap

- [ ] LoCoMo benchmark results (multi-session, temporal, adversarial QA)
- [ ] Multi-hop graph traversal (recursive CTE for 2-hop "why" explanations)
- [ ] Export/import (JSON + Markdown) for memory portability
- [ ] 3D Dashboard real-time WebSocket feed
- [ ] MCP server for Claude Code (replace flat-file memory with Shiba)
- [ ] LangChain/LangGraph integration adapter
- [ ] Docker one-click deploy for non-PostgreSQL users

## Contributing

Issues and PRs welcome. Start with the [roadmap items above](#roadmap) or check [open issues](https://github.com/ryaboy25/shiba-memory/issues).

## License

MIT
