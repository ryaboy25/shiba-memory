# Shiba Memory — Architecture v2

## What This Document Is

A complete architecture for Shiba's next evolution. Not a wishlist — a buildable design with schema changes, code paths, and phased execution. Every component described here has a clear implementation path using PostgreSQL, TypeScript, and an optional LLM layer.

---

## The Core Insight

**The intelligence should live in the scoring, not the extraction.**

Mem0 burns 30-50K tokens per session extracting facts via LLM. Honcho burns 50-100K tokens running dialectical reasoning. Both achieve high benchmark scores but at significant cost.

Shiba's approach: store cheaply, score intelligently, extract selectively.

| Layer | Mem0 | Honcho | Shiba v2 |
|-------|------|--------|----------|
| Storage cost per session | ~40K tokens | ~80K tokens | ~1.3K tokens |
| Where intelligence lives | LLM prompts | LLM prompts | SQL functions + targeted LLM |
| Works without LLM | No | No | **Yes** (Tier 1 only) |
| Works offline | No | No | **Yes** |

---

## System Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  AI Agent (Claude Code / Hermes / LangChain / Custom)          │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────────────────┐  │
│  │ .shiba/     │  │ Hooks        │  │ Gateway API           │  │
│  │ Files       │  │ (lifecycle)  │  │ (Hono + zod)          │  │
│  │             │  │              │  │                       │  │
│  │ user.md     │  │ SessionStart │  │ POST /remember        │  │
│  │ project.md  │  │ PostToolUse  │  │ POST /recall          │  │
│  │ skills.md   │  │ Stop         │  │ POST /forget          │  │
│  │ feedback.md │  │ PreCompact   │  │ GET  /memory/:id      │  │
│  │             │  │ PostCompact  │  │ POST /link            │  │
│  └──────┬──────┘  └──────┬───────┘  └───────────┬───────────┘  │
│         │                │                       │              │
│  ┌──────┴────────────────┴───────────────────────┴───────────┐  │
│  │                    Extraction Layer                        │  │
│  │                                                           │  │
│  │  Tier 1: Pattern Matching (free, always on)               │  │
│  │    "I prefer..." → feedback memory                        │  │
│  │    "Always use..." → skill memory                         │  │
│  │    "Don't do..." → feedback memory                        │  │
│  │    Tool events → episode memory                           │  │
│  │                                                           │  │
│  │  Tier 2: Targeted LLM (~200-500 tokens, on triggers)     │  │
│  │    User correction detected → extract what changed        │  │
│  │    Decision discussed → extract the decision              │  │
│  │    Session ends → summarize key points                    │  │
│  │                                                           │  │
│  │  Tier 3: Batch LLM (daemon, every few hours)             │  │
│  │    Evolve instincts → skills                              │  │
│  │    Detect contradictions via NLI                           │  │
│  │    Cross-project pattern synthesis                         │  │
│  │    Generate session-level summaries                        │  │
│  └───────────────────────────┬───────────────────────────────┘  │
│                              │                                  │
│  ┌───────────────────────────┴───────────────────────────────┐  │
│  │              PostgreSQL 16 + pgvector                      │  │
│  │                                                           │  │
│  │  memories         memory_links      conversations         │  │
│  │  ┌────────────┐  ┌────────────┐   ┌────────────────┐     │  │
│  │  │ embedding  │  │ source_id  │   │ session_id     │     │  │
│  │  │ fts        │  │ target_id  │   │ summary        │     │  │
│  │  │ confidence │  │ relation   │   │ files_touched  │     │  │
│  │  │ access_ts  │  │ strength   │   │ decisions      │     │  │
│  │  │ importance │  └────────────┘   └────────────────┘     │  │
│  │  │ type       │                                           │  │
│  │  │ tags       │  scoped_recall() — hybrid search          │  │
│  │  │ profile    │  ACT-R scoring (fast + proper modes)      │  │
│  │  │ project    │  Confidence × Graph × Recency × Project   │  │
│  │  └────────────┘                                           │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

---

## The Three Tiers (Detailed)

### Tier 1: Pattern Matching (Zero Tokens)

Runs in hooks. No LLM needed. Covers ~70% of useful memory capture.

**Triggers and patterns:**

| Pattern | Detected By | Stored As | Example |
|---------|-------------|-----------|---------|
| `"I prefer..."` / `"I like..."` / `"I always..."` | Regex on user messages | `user` memory | "I prefer functional patterns" |
| `"Don't..."` / `"Stop..."` / `"Never..."` | Regex on user messages | `feedback` memory | "Don't mock the database" |
| `"Remember that..."` / `"Note that..."` | Regex on user messages | `user` or `project` | "Remember that auth uses JWT" |
| User corrects AI output | Diff between edit and AI suggestion | `feedback` instinct | "User rejected semicolons" |
| File created/edited | PostToolUse hook | `episode` memory | "Created auth.ts" |
| Command run | PostToolUse hook | `episode` memory | "Ran npm test" |
| Session starts | SessionStart hook | Recall + inject context | Load .shiba/ files |
| Context compressed | PreCompact hook | `episode` snapshot | Save decisions before loss |

**Implementation:** A `PatternExtractor` class in `cli/src/extraction/patterns.ts` that takes a message string and returns zero or more `{type, title, content, confidence}` objects.

```typescript
// No LLM. Just regex + heuristics.
interface ExtractedFact {
  type: "user" | "feedback" | "project" | "skill" | "instinct";
  title: string;
  content: string;
  confidence: number; // 0.3 for instincts, 0.7 for explicit statements
}

function extractPatterns(message: string, role: "user" | "assistant"): ExtractedFact[];
```

### Tier 2: Targeted LLM (~200-500 tokens per call)

Runs on specific trigger moments. Not every message — only when something worth extracting is detected.

**Triggers:**

| Trigger | When | What LLM Does | Tokens |
|---------|------|---------------|--------|
| User correction | User says "no", "wrong", "actually..." after AI output | Extract: what was wrong, what's correct | ~300 |
| Decision made | Discussion converges on a choice | Extract: what was decided and why | ~400 |
| Session end | Stop hook fires | Summarize: key topics, decisions, learnings | ~500 |
| Knowledge update | New fact contradicts existing memory | Determine: which is current? | ~300 |

**Implementation:** A `TargetedExtractor` class in `cli/src/extraction/targeted.ts` that uses the LLM provider.

```typescript
interface ExtractionResult {
  facts: ExtractedFact[];
  tokens_used: number;
}

async function extractCorrection(userMessage: string, aiOutput: string): Promise<ExtractionResult>;
async function extractDecision(conversationSnippet: string): Promise<ExtractionResult>;
async function summarizeSession(messages: Message[]): Promise<ExtractionResult>;
```

### Tier 3: Batch Processing (Daemon, Every Few Hours)

Runs on your schedule using a local model. Not in the critical path.

| Operation | What It Does | Tokens | Frequency |
|-----------|-------------|--------|-----------|
| Instinct evolution | Find instincts with high confidence + access count, verify via LLM, promote to skills | ~1000 | Every 4 hours |
| Contradiction detection | For memory pairs with overlapping tags + moderate similarity, ask LLM "do these contradict?" | ~500 per pair | Every 4 hours |
| Session summaries | Summarize recent episodes into consolidated project context | ~1000 | Daily |
| Cross-project insights | Analyze tag patterns across projects, generate insight memories | ~500 | Daily |

**Implementation:** Enhanced `reflect.ts` consolidation that optionally uses the LLM provider.

---

## LLM Provider Layer

Provider-agnostic, like the embedding layer. Supports every common setup.

```
cli/src/
  llm.ts                    # Provider interface + retry + fallback
```

**Config:**
```bash
# In .env
SHB_LLM_PROVIDER=openai-compatible   # or "ollama", "anthropic", "none"
SHB_LLM_URL=http://localhost:8080     # llama.cpp, vLLM, OpenRouter, etc.
SHB_LLM_MODEL=gemma-4                # model name for the API
SHB_LLM_API_KEY=                      # optional, for cloud providers
SHB_LLM_TIMEOUT_MS=15000             # request timeout
SHB_LLM_RETRIES=1                    # retry count
```

**Provider compatibility:**

| User Setup | Provider | URL |
|-----------|----------|-----|
| Your server (Gemma 4 via llama.cpp) | `openai-compatible` | `http://localhost:8080` |
| Ollama | `ollama` | `http://localhost:11434` |
| OpenAI | `openai-compatible` | `https://api.openai.com` |
| Anthropic | `anthropic` | `https://api.anthropic.com` |
| OpenRouter | `openai-compatible` | `https://openrouter.ai/api` |
| Together AI | `openai-compatible` | `https://api.together.xyz` |
| No LLM budget | `none` | — |

**`none` is first-class.** Shiba works without any LLM for extraction. Tier 1 patterns still capture memories. Search still works. ACT-R still scores. You just don't get the targeted extraction and batch processing.

```typescript
// cli/src/llm.ts
interface LLMProvider {
  chat(messages: {role: string, content: string}[], maxTokens?: number): Promise<string>;
}

// Returns the configured provider, or a no-op if SHB_LLM_PROVIDER=none
export function getLLMProvider(): LLMProvider;
```

---

## The File Bridge (.shiba/ Directory)

Materialized views of database state, written as markdown. Not LLM-generated — just formatted query results.

```
.shiba/
  user.md        # Top user facts + preferences (from type=user memories)
  project.md     # Project context + decisions (from type=project, scoped to cwd)
  skills.md      # Learned patterns (from type=skill)
  feedback.md    # Active corrections (from type=feedback, high confidence)
  context.md     # Auto-generated: recent episodes + session summary
```

**How it works:**

1. **SessionStart hook** queries DB for relevant memories, writes .shiba/ files
2. **Claude Code / Hermes** reads .shiba/ files as part of system context (via CLAUDE.md reference)
3. **During session**: files are read-only (agent reads them, doesn't write)
4. **Session end**: new memories are stored in DB, .shiba/ files regenerated

**File generation is NOT an LLM call.** It's a SQL query + string template:

```typescript
// cli/src/commands/materialize.ts
async function materializeUserFile(projectPath: string): Promise<string> {
  const memories = await recall({ query: "user preferences identity", type: "user", limit: 10 });
  let md = "# About the User\n\n";
  for (const m of memories) {
    md += `- **${m.title}**: ${m.content}\n`;
  }
  return md;
}
```

**Bidirectional sync (future):** If a user edits .shiba/user.md directly, a file watcher detects the change and updates/creates corresponding memories in the DB. This is a nice-to-have, not required for v2.

---

## What Makes This Different (Honest Assessment)

### vs. Mem0
- Mem0 burns tokens on every interaction. Shiba burns tokens selectively (Tier 2) or not at all (Tier 1).
- Mem0 is vector-only search. Shiba is hybrid semantic + full-text.
- Mem0 has no cognitive scoring. Shiba has ACT-R decay, confidence, graph boost.
- Mem0 has no file materialization. Shiba has .shiba/ directory.
- Mem0 has a much larger ecosystem (LangChain, LlamaIndex, etc.).

### vs. Honcho
- Honcho runs two LLM passes per conversation. Shiba runs zero to a few.
- Honcho only models the user. Shiba models user + project + skills + episodes + feedback.
- Honcho has dialectical reasoning (novel). Shiba has instinct→skill evolution (novel).
- Honcho scores 89% because GPT-4o judges its GPT-4o-extracted answers. Shiba scores 61% with a fully local Gemma 4 judge — apples to oranges.

### vs. Letta
- Letta's agent manages its own memory (the LLM decides). Shiba's memory is deterministic + inspectable.
- Letta is a full agent framework. Shiba is a memory layer that plugs into any agent.
- Letta's approach is more autonomous. Shiba's is more predictable and cheaper.

### What We Don't Have (And That's OK)
- No full graph database (we have adjacency list — sufficient for direct relationships)
- No multi-hop graph traversal (not needed for the memory use case)
- No dialectical reasoning (we have instinct evolution instead)
- No multi-tenancy (not needed until multi-user — add later with RLS)

---

## Schema Changes Required

### New table: extraction_log
```sql
CREATE TABLE extraction_log (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tier        TEXT NOT NULL CHECK (tier IN ('pattern', 'targeted', 'batch')),
    trigger     TEXT NOT NULL,          -- what caused the extraction
    input_hash  TEXT,                   -- dedup: don't re-extract same content
    facts_created INT DEFAULT 0,
    tokens_used INT DEFAULT 0,
    created_at  TIMESTAMPTZ DEFAULT now()
);
```

### New columns on memories
```sql
ALTER TABLE memories ADD COLUMN IF NOT EXISTS extraction_tier TEXT DEFAULT 'manual';
-- Tracks how this memory was created: 'manual', 'pattern', 'targeted', 'batch', 'hook'
```

### No other schema changes needed
The existing schema (memories, memory_links, conversations, events_queue) handles everything. The tiered extraction just creates memories through the existing `remember()` function.

---

## Execution Plan

### Phase A: LLM Provider Layer + Pattern Extraction (1-2 days)
*Foundation. No LLM required — patterns work without it.*

1. Create `cli/src/llm.ts` — provider interface with openai-compatible, ollama, anthropic, none
2. Create `cli/src/extraction/patterns.ts` — regex-based fact extraction from messages
3. Create `cli/src/extraction/targeted.ts` — LLM-based extraction (correction, decision, summary)
4. Create `schema/009_extraction_log.sql` — extraction tracking table
5. Wire pattern extraction into PostToolUse hook — detect "I prefer", "Don't do", etc.
6. Tests for pattern extraction (pure functions, no DB needed)

### Phase B: File Bridge (.shiba/ materialization) (1-2 days)
*Makes memory visible to agents and humans.*

1. Create `cli/src/commands/materialize.ts` — generate .shiba/ files from DB
2. Wire into SessionStart hook — generate files on session start
3. Wire into Stop hook — regenerate after session
4. Add `shiba materialize` CLI command for manual generation
5. Update CLAUDE.md reference to point agents at .shiba/ files

### Phase C: Targeted Extraction Integration (1-2 days)
*Hooks use Tier 2 extraction on correction/decision moments.*

1. Update PostToolUse hook — detect corrections (user edits AI output)
2. Update Stop hook — call `summarizeSession()` with Tier 2 LLM
3. Add `SHB_LLM_*` config to .env.example
4. Handle `SHB_LLM_PROVIDER=none` gracefully (skip Tier 2, Tier 1 still works)
5. Integration tests with mock LLM provider

### Phase D: Enhanced Batch Processing (1-2 days)
*Daemon uses Tier 3 for smarter consolidation.*

1. Update `evolve.ts` — use LLM to verify instinct→skill promotions
2. Update `reflect.ts` — use LLM for contradiction detection (NLI instead of embedding distance)
3. Add session summarization to daemon cycle
4. All Tier 3 operations are optional — `SHB_LLM_PROVIDER=none` skips them

### Phase E: Benchmark + Polish (1-2 days)
*Measure the improvement. Fix benchmark regression.*

1. Debug current 0% LLM-judge regression
2. Re-run LongMemEval with all tiers active
3. Add benchmark for extraction quality (what % of facts are correctly captured)
4. Update README with new architecture and results

---

## Token Budget Summary

| Scenario | Tokens/Session | Monthly Cost (cloud) | Monthly Cost (local) |
|----------|---------------|---------------------|---------------------|
| Tier 1 only (no LLM) | 0 | $0 | $0 |
| Tier 1 + 2 (targeted) | ~1,300 | ~$0.01 | $0 (Ollama/llama.cpp) |
| Tier 1 + 2 + 3 (full) | ~1,300 + ~5K batch | ~$0.05 | $0 (Ollama/llama.cpp) |
| Mem0 (comparison) | ~40,000 | ~$0.30 | N/A (requires cloud) |
| Honcho (comparison) | ~80,000 | ~$0.60 | N/A (requires cloud) |

At 20 sessions/day, 30 days: Shiba full = ~$30/mo cloud or $0 local. Mem0 = ~$180/mo. Honcho = ~$360/mo.

---

## What This Doesn't Change

- **Database**: Still PostgreSQL + pgvector. No new databases.
- **Search**: Still hybrid semantic + full-text with ACT-R scoring.
- **CLI**: All existing commands still work.
- **Gateway API**: All existing endpoints still work. New ones added.
- **Hooks**: Same 5 hooks, enhanced with extraction.
- **Hermes plugin**: Same interface, benefits from better memories.
- **Benchmark adapter**: Same interface, measures improvement.
