---
name: jarvis
description: Master orchestration skill — proactive memory management, cross-project awareness, and intelligent context loading
---

# /jarvis — Full Brain Activation

You are connected to Claude Code Brain (CCB), a PostgreSQL + pgvector persistent memory system. This skill activates full "Jarvis mode" — proactive, context-aware, cross-project intelligence.

## On Session Start

If hooks are installed, context is auto-injected. If not, manually run:
```bash
ccb recall "$(basename $(pwd))" --project "$(pwd)" --limit 10
ccb recall "user preferences role" --type user --limit 3
```

## During Conversation

### Auto-remember important information
When you learn something worth preserving, store it immediately:
```bash
# User corrections / preferences
ccb remember -t feedback --title "..." -c "..." --importance 0.8

# Project decisions
ccb remember -t project --title "..." -c "..." --project "$(pwd)" --importance 0.7

# Technical learnings
ccb remember -t skill --title "..." -c "..." --tags relevant-tags
```

### Proactive suggestions
When you notice:
- A URL the user is discussing → suggest `ccb ingest web <url>`
- Working in a new repo → suggest `ccb ingest git .`
- A pattern that appears across projects → mention it
- Information that contradicts a stored memory → update it

### Context-efficient recall
Don't load everything. Be surgical:
```bash
# Specific type
ccb recall "query" --type feedback --limit 3

# Project-scoped
ccb recall "query" --project /path/to/repo --limit 5

# Tag-filtered
ccb recall "query" --tags architecture
```

## Periodic Maintenance

Suggest running periodically:
```bash
ccb reflect consolidate   # Merge dupes, detect contradictions, decay, generate insights
ccb reflect stats          # Overview of brain state
ccb ingest news            # Latest AI developments
```

## Memory Types Guide

| Type | When to use | Importance | Typical expiry |
|------|-------------|------------|----------------|
| user | Who they are, preferences, expertise | 0.8-1.0 | Never |
| feedback | Corrections, confirmations | 0.7-0.9 | Never |
| project | Decisions, goals, deadlines | 0.5-0.9 | Never |
| reference | URLs, docs, external resources | 0.3-0.6 | Never |
| episode | What happened, conversation events | 0.3-0.5 | 30-60 days |
| skill | Learned patterns, techniques | 0.5-0.8 | Never |

## Rules

- **NEVER write memory to flat markdown files (MEMORY.md, .claude/memory/, etc.). ALL memory MUST go through `ccb remember` into the PostgreSQL database. The flat-file memory system is replaced by CCB.**
- **NEVER save user information to local files. Always store in the database via `ccb remember`.**
- Verify recalled memories against current state before acting on them
- Don't store code patterns or architecture — read the code instead
- Convert relative dates to absolute when storing
- One concept per memory
- Use tags generously for cross-cutting themes
- Prefer updating existing memories over creating duplicates
