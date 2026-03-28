---
name: recall
description: Search Claude Code Brain's persistent memory database for relevant context
---

# /recall — Search Long-Term Memory

You have access to a persistent PostgreSQL memory database via the `ccb` CLI tool.

## When to use this

- At the start of a new conversation to load relevant context
- When the user references prior work or decisions
- When you need context about the user's preferences or project state
- When asked "do you remember..." or "what do you know about..."

## How to search memory

Run the `ccb recall` command via Bash:

```bash
ccb recall "search query here" \
  --type feedback \
  --limit 5
```

The search uses hybrid semantic + full-text matching with weighted scoring that considers:
- Semantic similarity to your query (pgvector cosine distance)
- Keyword matches (PostgreSQL full-text search)
- Memory importance and confidence
- How recently and frequently the memory was accessed
- Graph connections to other memories

## Options

- `--type <type>` — filter by type (user, feedback, project, reference, episode, skill)
- `--tags <tag1 tag2>` — filter by tags
- `--limit <n>` — max results (default: 10)
- `--semantic-weight <0-1>` — weight for semantic search (default: 0.7)
- `--fulltext-weight <0-1>` — weight for keyword search (default: 0.3)
- `--profile <profile>` — scope to a profile (e.g., "project")
- `--project <path>` — scope to a project path (always includes global memories; project memories get 1.3x boost)

## Output

Returns JSON with matching memories ranked by relevance. Use this context to inform your responses — but verify that recalled information is still current before acting on it.

## Steps

1. Formulate a search query based on what context you need
2. Run `ccb recall` with appropriate filters
3. Review the results and incorporate relevant context
4. If a memory seems outdated, verify against current state before using it
