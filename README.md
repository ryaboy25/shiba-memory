# Shiba Memory

Persistent memory for AI agents that learns and never forgets. Shiba stores memories with semantic search, knowledge graphs, and automatic learning — accessible via CLI, HTTP gateway, or Claude Code hooks.

**Framework-agnostic**: works with Claude Code, Hermes, LangChain, custom agents, or anything that speaks HTTP.

## Why Shiba?

| Feature | Shiba | Mem0 | Zep | Letta | ByteRover |
|---------|-----|------|-----|-------|-----------|
| Hybrid search (semantic + FTS) | **Yes** | Vector only | Graph+semantic | Agent-managed | File-based |
| Self-improving memory (instinct→skill) | **Yes** | No | No | LLM-managed | No |
| Knowledge graph | **Yes** | Pro ($249/mo) | Temporal KG | No | No |
| Cross-project insights | **Yes** | No | No | No | No |
| ACT-R cognitive decay | **Yes** | No | No | No | No |
| Halfvec optimization (50% memory savings) | **Yes** | No | No | No | No |
| Self-hosted & open source | **Yes** | Yes | Partial | Yes | Yes |
| Claude Code hooks | **Native** | No | No | No | No |

## What It Does

- **Remembers everything** across all sessions, all projects, all repos
- **Searches by meaning** not just keywords (hybrid semantic + full-text search)
- **Builds a knowledge graph** linking related memories automatically
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
        "command": "node \"/path/to/claude-code-brain/cli/dist/hooks/session-start.js\"",
        "timeout": 5
      }]
    }],
    "PostToolUse": [{
      "matcher": "Edit|Write|Bash",
      "hooks": [{
        "type": "command",
        "command": "node \"/path/to/claude-code-brain/cli/dist/hooks/post-tool.js\"",
        "timeout": 5
      }]
    }],
    "Stop": [{
      "matcher": "",
      "hooks": [{
        "type": "command",
        "command": "node \"/path/to/claude-code-brain/cli/dist/hooks/stop.js\"",
        "timeout": 5
      }]
    }],
    "PreCompact": [{
      "matcher": "",
      "hooks": [{
        "type": "command",
        "command": "node \"/path/to/claude-code-brain/cli/dist/hooks/pre-compact.js\"",
        "timeout": 5
      }]
    }],
    "PostCompact": [{
      "matcher": "",
      "hooks": [{
        "type": "command",
        "command": "node \"/path/to/claude-code-brain/cli/dist/hooks/post-compact.js\"",
        "timeout": 5
      }]
    }]
  }
}
```

Replace `/path/to/claude-code-brain` with your actual install path.

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

### Integration Examples

**Python (any agent)**:
```python
import httpx

SHIBA = "http://localhost:18789"
HEADERS = {"Content-Type": "application/json", "X-Shiba-Key": "your-key"}

# Store a memory
httpx.post(f"{SHIBA}/remember", headers=HEADERS, json={
    "type": "user",
    "title": "User Role",
    "content": "Senior engineer at ACME, specializes in distributed systems",
    "importance": 0.9
})

# Search memories
resp = httpx.post(f"{SHIBA}/recall", headers=HEADERS, json={
    "query": "what does the user specialize in",
    "limit": 5
})
memories = resp.json()["memories"]
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

Two search arms run in parallel:
1. **Semantic**: pgvector cosine similarity on halfvec(512)
2. **Full-text**: PostgreSQL websearch_to_tsquery on a generated tsvector column

Results are fused with configurable weights (default 70% semantic, 30% keyword), then scored with:

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

Embeddings are stored at full 32-bit precision but indexed as 16-bit halfvec. The HNSW index uses half the memory with negligible accuracy loss — verified across 512 dimensions with nomic-embed-text.

## Benchmarks

### LongMemEval Results (500 questions, oracle split)

| System | Score | Judge Model | Embedding | Self-hosted |
|--------|-------|-------------|-----------|-------------|
| **Shiba** | **45.6%** | Gemma 4 26B Q3 (local) | nomic-embed-text (local) | **Yes** |
| Mem0 | 49.0% | GPT-4o (cloud) | OpenAI (cloud) | Partial |
| Zep | 63.8% | GPT-4o (cloud) | OpenAI (cloud) | No |
| Honcho | 89.9% | GPT-4o (cloud) | OpenAI (cloud) | Yes |

**By question type:**

| Category | Shiba | Notes |
|----------|-------|-------|
| Single-session-user | **70.0%** | Best category — user-stated facts |
| Knowledge-update | 52.6% | Fact changes over time |
| Multi-session | 50.4% | Cross-session reasoning |
| Temporal-reasoning | 48.1% | Time-based queries |
| Single-session-assistant | 48.2% | Assistant-generated content |
| Single-session-preference | 10.0% | Implicit preferences (weakest) |

**Key context:** Shiba is the only system scoring 45%+ that runs entirely locally with no cloud dependencies. Mem0, Zep, and Honcho all use GPT-4o as judge, which is a significantly stronger evaluator than the local Gemma 4 26B Q3.

**Retrieval latency:** 32ms avg — faster than all competitors.

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
    embeddings.ts                 # Ollama / OpenAI / hashtest providers
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
  benchmarks/
    shiba_adapter.py              # Benchmark adapter for LongMemEval/LoCoMo
    run_longmemeval.py            # Raw retrieval benchmark
    run_longmemeval_judge.py      # LLM-as-judge benchmark
    run_benchmarks.sh             # Runner script
    pyproject.toml                # Python dependencies
  plugins/
    hermes/                       # Hermes agent memory provider plugin
```

## Inspired By

Built after studying these projects:
- [Ogham MCP](https://github.com/ogham-mcp/ogham-mcp) — hybrid search architecture, halfvec trick, ACT-R scoring
- [Superpowers](https://github.com/obra/superpowers) — skills-as-markdown, session bootstrap pattern
- [everything-claude-code](https://github.com/affaan-m/everything-claude-code) — instinct learning system
- [CLAWDBOT](https://github.com/HarleyCoops/CLAWDBOT) — gateway pattern, daily logs
- [Anthropic Harnesses](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) — JSON progress tracking, context engineering

## License

MIT
