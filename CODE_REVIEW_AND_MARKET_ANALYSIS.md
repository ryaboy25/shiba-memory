# Shiba Memory — Full Code Review, Market Analysis & Competitive Comparison

> Independent analysis conducted April 11, 2026. Unbiased assessment of technical merit, market positioning, and competitive landscape.

---

## Part 1: Shiba Memory Code Review

### Project Overview

Shiba Memory is a persistent memory system for AI agents, built in TypeScript (Node 22), backed by PostgreSQL 16 + pgvector. It provides a CLI (`shiba`), an HTTP gateway (port 18789), native Claude Code hooks, and a Hermes agent plugin. The codebase is ~8,500 lines of TypeScript + ~1,500 lines of SQL across 16 migrations, with ~870 lines of tests.

**Repo stats**: 51 commits, 4 days old (Apr 7–10, 2026), 1 primary contributor.

---

### Architecture Assessment

#### Strengths

- **Single-database simplicity.** Everything lives in PostgreSQL — vectors, full-text search, knowledge graph, events, entities. No Neo4j, no Redis, no separate vector DB. This is a major operational advantage over competitors like Zep (requires Neo4j + PG + search index) or Cognee (PG + vector DB + graph DB).

- **5-channel Reciprocal Rank Fusion.** The `scoped_recall` SQL function fuses semantic (HNSW), full-text (tsvector), temporal, entity graph, and substring match channels via RRF. This is more sophisticated than most competitors — Mem0 uses vector-only search (graph in Pro), gbrain uses 2-channel RRF (vector + keyword).

- **Halfvec trick.** Storing vectors at full `vector(512)` precision but indexing/querying as `halfvec(512)` via HNSW halves index memory with negligible accuracy loss. Neither gbrain (full 1536-dim vectors) nor any other competitor implements this optimization.

- **ACT-R cognitive scoring.** The power-law decay model (`B_i = ln(Σ(t_j^(-0.5)))`) for recall scoring is unique in the entire market. No competitor implements cognitive-science-inspired access frequency + recency scoring.

- **Tiered extraction (0-token to LLM).** Tier 1 pattern matching costs zero tokens and catches common cases (preferences, corrections, decisions). Tier 2 targeted LLM extraction runs only when needed (~300–500 tokens). This is more cost-efficient than Mem0 or Zep, which require LLM calls for all extraction.

- **Framework-agnostic integration.** HTTP gateway, CLI, Claude Code hooks, Hermes plugin, MCP server — multiple integration paths. gbrain has no HTTP gateway at all.

#### Weaknesses

- **Test coverage is thin.** 867 lines of tests for 8,500 lines of source code is roughly a 10% ratio. Critical paths like the RRF scoring function, ACT-R calculation, and hook logic deserve more coverage.

- **Single-contributor risk.** 49 of 51 commits from one person. The bus factor is 1. No external contributions yet beyond a single merge.

- **No standalone SDK.** The Python SDK exists via the Hermes plugin, but there's no standalone Python or JavaScript SDK package. Mem0 ships Python + JS SDKs. Letta ships Python + TypeScript. Zep ships Python + TypeScript + Go.

- **512-dim embeddings are a tradeoff.** Using 512 dimensions (vs gbrain's 1536 or Mem0's typical 1536) saves memory but reduces embedding expressiveness. For a personal memory system this is likely fine, but for enterprise-scale knowledge bases it could matter.

- **No managed cloud option.** Every competitor (Mem0, Letta, Zep, Cognee) offers or is building a managed cloud. Shiba is self-hosted only. Fine for developer-oriented users but limits broader adoption.

- **Young codebase.** 4 days of development. While the architecture is thoughtful, it hasn't been battle-tested at scale.

---

### Code Quality

| Aspect | Assessment |
|--------|-----------|
| **TypeScript strictness** | Strict mode enabled, ES2022 target. Good. |
| **Error handling** | Layered: CLI exits with codes, hooks fail silently, gateway returns structured errors, LLM degrades gracefully. Well-designed. |
| **Validation** | Zod schemas at the gateway, SQL CHECK constraints at the DB, Commander parsing at the CLI. Three layers — solid. |
| **Security** | Timing-safe API key comparison, rate limiting (120 RPM), CORS config, body size limits (1MB), non-root Docker user. Reasonable for the project stage. |
| **Dependencies** | Lean — 10 production deps. No bloat. Hono is a good choice for the gateway (lightweight, fast). |
| **SQL design** | The schema is the strongest part of the codebase. Generated tsvector columns, HNSW halfvec indexes, proper UPSERT semantics, cascading deletes. The 17 SQL functions are well-crafted. |
| **Separation of concerns** | Clean. Commands, hooks, extraction, utils, and DB are in separate modules. The gateway maps cleanly to DB operations. |

---

### Benchmark Results

Shiba claims:
- **HaluMem-Medium: 90.7% FMR** (False Memory Resistance) across 20 users, 12,300 memory points, 2,648 interference points — significantly outperforms Mem0's ~65%.
- **LongMemEval: 50.2%** vs Mem0's 49.0% (marginal win) but behind Zep's 63.8%.
- **34ms hybrid retrieval latency.**

These are strong numbers, especially the HaluMem score. The write-time dedup (0.92 similarity threshold) and Bayesian confidence updates likely contribute to the high false memory resistance. However, benchmarks should be independently verified — self-reported numbers from a 4-day-old project warrant healthy skepticism.

---

## Part 2: Head-to-Head — Shiba Memory vs gbrain

### Overview

| Dimension | Shiba Memory | gbrain |
|-----------|-------------|--------|
| **Creator** | ryaboy25 | Garry Tan (YC President) |
| **Stars** | New (low) | 2,425 |
| **Age** | 4 days (Apr 7–10) | 6 days (Apr 5–10) |
| **Language** | TypeScript (Node 22) | TypeScript (Bun) |
| **License** | — | MIT |
| **LOC** | ~10,000 (TS + SQL) | ~3,700 (estimated) |
| **Version** | Pre-release | 0.5.0 |

### Architectural Philosophy

These two systems solve fundamentally different problems:

**Shiba = Agent Memory Infrastructure.** It's a hippocampus — it stores, scores, retrieves, consolidates, and decays memories for any AI agent via a standard HTTP API. The agent doesn't need to know how memory works; it just calls `/remember` and `/recall`.

**gbrain = Personal Knowledge Management System.** It's an entire filing office — structured pages with compiled truth + append-only timelines, a MECE directory taxonomy, enrichment pipelines, and a 10,000-word operational doctrine (the "skillpack"). The agent must understand the system's philosophy to use it effectively.

gbrain's own documentation acknowledges this distinction: *"GBrain holds world facts. Agent memory holds how the agent operates."*

### Feature Comparison

| Feature | Shiba Memory | gbrain |
|---------|-------------|--------|
| **Source of truth** | PostgreSQL database | Git repo (markdown files) |
| **Primary interface** | HTTP Gateway (17 endpoints) | MCP server (stdio) + CLI |
| **HTTP API** | Yes (full REST) | No |
| **Embedding provider** | Ollama (local/free) or OpenAI | OpenAI only (paid) |
| **Vector dimensions** | 512 (halfvec optimized) | 1536 (full precision) |
| **Search method** | 5-channel RRF + ACT-R scoring | 2-channel RRF (vector + keyword) |
| **Query expansion** | Query classifier (local) | Claude Haiku (paid API call per query) |
| **Memory scoring** | ACT-R decay + Bayesian confidence | Relevance-only (no decay/confidence) |
| **Knowledge graph** | `memory_links` table (6 relation types) | `links` table + markdown cross-refs |
| **Memory consolidation** | Built-in (`reflect consolidate`) | Manual ("brain lint" cron) |
| **Memory decay** | Built-in (confidence * 0.9 for >60d idle) | None |
| **Deduplication** | Write-time (similarity > 0.92) | 4-layer read-time dedup |
| **Entity resolution** | Built-in (canonical names + aliases) | Via skillpack (agent-driven) |
| **Auth** | API key (timing-safe) | None (single-user) |
| **Multi-user/agent** | Yes (SQL-level isolation) | No (personal brain) |
| **Event system** | Yes (queue, webhooks, channels) | No |
| **Self-improvement** | Instincts evolve to skills | No |
| **Temporal awareness** | Temporal search + `temporal_ref` column | Timeline entries (append-only) |
| **Cost to run** | Free (Ollama + local PG) | $25/mo Supabase + OpenAI + Anthropic API |
| **Agent hooks** | Native Claude Code hooks | None (MCP tools instead) |
| **Hermes integration** | Native Python plugin | Native (designed for OpenClaw/Hermes) |
| **Dashboard** | 3D brain visualization (Next.js + Three.js) | None |
| **Benchmarks** | HaluMem 90.7%, LongMemEval 50.2% | None published |
| **Documentation** | CLAUDE.md + ARCHITECTURE.md + README | 10,000-word skillpack + CLAUDE.md |

### Where gbrain Wins

1. **Human-readable source of truth.** Markdown files in Git are inspectable, diffable, version-controlled, and portable. If the database dies, the brain survives. Shiba's source of truth is PostgreSQL — if the DB dies without backups, everything is lost.

2. **The Skillpack.** gbrain ships a 10,000-word operational doctrine that defines production agent behavior patterns — entity detection, enrichment pipelines, meeting ingestion, email triage, dream cycles. This is an opinionated but comprehensive playbook. Shiba has no equivalent guidance document.

3. **Compiled truth + timeline pattern.** Separating synthesized knowledge (rewritable) from evidence (append-only, immutable) is a clever knowledge management primitive that provides provenance tracking. Shiba stores flat memories without this distinction.

4. **Community traction.** 2,425 stars in 6 days, driven by Garry Tan's profile. Shiba has minimal community presence.

5. **Multi-query expansion.** Using Claude Haiku to rephrase queries before searching improves recall for ambiguous queries. Shiba doesn't expand queries (though the query classifier adjusts retrieval strategy).

### Where Shiba Memory Wins

1. **Cost.** Shiba can run entirely locally and free (Ollama + Docker PostgreSQL). gbrain requires OpenAI API for embeddings, Anthropic API for query expansion, and recommends Supabase Pro ($25/mo).

2. **HTTP API.** Shiba's 17-endpoint REST gateway means any language, any framework, any agent can integrate with a simple HTTP call. gbrain has no HTTP API — integration requires MCP (stdio) or CLI subprocess calls, limiting its reach.

3. **Cognitive scoring.** ACT-R decay, Bayesian confidence updates, and access frequency tracking mean Shiba's recall improves over time as it learns which memories are useful. gbrain's search is purely relevance-based with no learning signal.

4. **Memory lifecycle management.** Automated consolidation, decay, dedup, contradiction detection, and instinct-to-skill evolution. gbrain relies on manual or cron-driven maintenance with no built-in intelligence.

5. **Multi-user/agent isolation.** Built into the SQL layer with `user_id` and `agent_id` columns + indexes. gbrain is explicitly single-user.

6. **Benchmarks.** Shiba publishes HaluMem and LongMemEval numbers. gbrain publishes none.

7. **Search sophistication.** 5-channel RRF (semantic + FTS + temporal + entity graph + substring) vs gbrain's 2-channel (semantic + keyword).

8. **Auth and security.** Rate limiting, API key auth, CORS, body size limits. gbrain has none.

### Honest Assessment

gbrain and Shiba are **not direct competitors** — they solve adjacent but different problems. gbrain is a structured knowledge base (a "second brain" for a person), while Shiba is memory infrastructure for AI agents. A production system could reasonably use both: gbrain for world knowledge (people, companies, deals) and Shiba for agent operational memory (preferences, corrections, skills, session context).

If forced to choose one for **general-purpose AI agent memory**, Shiba is the more complete solution. If the goal is **personal knowledge management for a power user**, gbrain's opinionated structure and markdown-in-Git approach has clear advantages.

---

## Part 3: Market Landscape

### Competitor Overview

| System | Stars | Language | Primary DB | Local Deploy | Key Strength |
|--------|-------|----------|-----------|-------------|-------------|
| **Mem0** | 52,600 | Python | 20+ vector stores + Neo4j | Yes | Largest ecosystem, drop-in memory layer |
| **Letta** | 22,000 | Python | PostgreSQL / SQLite | Yes | Agent self-manages memory (MemGPT paradigm) |
| **Cognee** | 15,100 | Python | PG + Vector + Graph | Yes | Knowledge engineering pipeline, 30+ formats |
| **Zep** | 4,400 | Python | Neo4j + PG | Yes | Temporal knowledge graph, bi-temporal model |
| **gbrain** | 2,425 | TypeScript | PG + pgvector | Partial | Compiled truth pattern, skillpack doctrine |
| **Motorhead** | 911 | Rust | Redis | Yes | Simple, fast, unmaintained |
| **Shiba** | New | TypeScript | PG + pgvector | Yes | ACT-R scoring, tiered extraction, zero-cost local |

### How Shiba Stacks Up Against Each

**vs Mem0 (market leader):**
- Mem0 has 1000x the community, Python/JS SDKs, 20+ vector store backends, and enterprise customers.
- Shiba has better false memory resistance (90.7% vs ~65% HaluMem), comparable LongMemEval (50.2% vs 49.0%), cheaper operation (no LLM needed for Tier 1 extraction), and ACT-R scoring that Mem0 lacks.
- Mem0 requires LLM calls for all extraction (costly). Shiba's Tier 1 pattern matching is free.
- Honest take: Mem0 is the safer choice for production teams. Shiba has interesting technical ideas but lacks ecosystem maturity.

**vs Letta (agent framework):**
- Letta is a full agent framework, not just a memory layer. Different category.
- Letta's "agent manages its own memory" paradigm is elegant but adds complexity.
- Shiba is simpler to integrate — just HTTP calls. Letta requires adopting the entire framework.
- Not directly comparable; Shiba could serve as the memory backend for a Letta-like system.

**vs Zep (temporal graph):**
- Zep dominates on temporal retrieval (63.8% LongMemEval vs Shiba's 50.2%).
- Zep's bi-temporal model (event time + ingestion time) is more sophisticated than Shiba's single `temporal_ref` column.
- Zep requires Neo4j (operational complexity). Shiba does everything in PostgreSQL.
- Zep's 300ms P95 retrieval vs Shiba's claimed 34ms (different hardware/scale, not directly comparable).

**vs Cognee (knowledge engine):**
- Cognee processes 30+ document formats. Shiba ingests web, RSS, git, and files.
- Cognee has 70+ enterprise customers. Shiba has none.
- Cognee's pipeline architecture is more modular. Shiba's is more monolithic.
- Both support Ollama for local operation. Both use PostgreSQL.

### Shiba's Unique Market Position

Shiba occupies a niche that no competitor fully covers:

1. **TypeScript-native** — Every major competitor is Python-first. For Node/TypeScript agent ecosystems, Shiba is the only option that doesn't require a Python runtime.

2. **Zero-cost local operation** — Ollama embeddings + Docker PostgreSQL + Tier 1 pattern extraction = no API costs. Mem0 can run locally but still needs LLM for extraction. Zep needs LLM for entity extraction. gbrain needs OpenAI + Anthropic APIs.

3. **Claude Code native hooks** — No competitor has built-in Claude Code lifecycle integration. This is a strong wedge for the Claude Code user base.

4. **Cognitive-science scoring** — ACT-R + Bayesian confidence is academically grounded and unique in the market.

5. **Single-database simplicity** — PostgreSQL handles vectors, full-text, graph, events, entities, and config. No Neo4j, no Redis, no separate vector DB.

---

## Part 4: Summary Scorecard

| Dimension | Shiba | gbrain | Mem0 | Letta | Zep | Cognee |
|-----------|-------|--------|------|-------|-----|--------|
| **Search quality** | 8/10 | 7/10 | 7/10 | 6/10 | 9/10 | 7/10 |
| **Memory lifecycle** | 9/10 | 4/10 | 6/10 | 8/10 | 7/10 | 6/10 |
| **Operational simplicity** | 9/10 | 6/10 | 7/10 | 5/10 | 4/10 | 5/10 |
| **Cost efficiency** | 10/10 | 4/10 | 6/10 | 7/10 | 5/10 | 7/10 |
| **Ecosystem / community** | 2/10 | 5/10 | 10/10 | 8/10 | 6/10 | 7/10 |
| **Integration breadth** | 7/10 | 5/10 | 9/10 | 8/10 | 7/10 | 6/10 |
| **Documentation** | 6/10 | 8/10 | 9/10 | 8/10 | 7/10 | 6/10 |
| **Production readiness** | 3/10 | 3/10 | 9/10 | 8/10 | 7/10 | 7/10 |
| **Innovation** | 9/10 | 7/10 | 6/10 | 8/10 | 8/10 | 7/10 |

---

## Bottom Line

**Shiba Memory has strong technical fundamentals** — the ACT-R scoring, 5-channel RRF, halfvec optimization, tiered extraction, and single-database architecture are genuinely innovative. The HaluMem benchmark results, if reproducible, are best-in-class.

**The gaps are ecosystem, not engineering.** No community, no standalone SDKs, no cloud option, thin test coverage, single contributor. These are solvable problems but they determine whether a technically excellent project becomes a viable product.

**gbrain is a different tool for a different job.** Its compiled truth + timeline pattern and operational skillpack are impressive, but it's a personal knowledge management system, not general-purpose agent memory infrastructure. It's also locked into paid APIs with no local option.

**In the broader market,** Mem0 is the safe default with the largest ecosystem, Zep leads on temporal intelligence, Letta innovates on agent-managed memory, and Cognee dominates knowledge engineering. Shiba's strongest competitive position is as the **TypeScript-native, zero-cost, cognitively-grounded memory layer for Claude Code users** — a niche that's currently uncontested.
