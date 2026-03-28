---
name: reflect
description: Run maintenance on Claude Code Brain — view stats, decay old memories, find duplicates
---

# /reflect — Memory Maintenance

You have access to a persistent PostgreSQL memory database via the `ccb` CLI tool.

## When to use this

- Periodically to keep the memory database healthy
- When the user asks about memory status or health
- Before/after major project changes
- To find and consolidate duplicate memories

## Commands

```bash
# View memory statistics
ccb reflect stats

# FULL BRAIN MAINTENANCE — merge dupes, detect contradictions, decay, link, generate insights
ccb reflect consolidate

# Decay old unused memories (reduces confidence) and clean expired
ccb reflect decay

# Find near-duplicate memories (>92% similarity)
ccb reflect duplicates

# Check database health
ccb health

# Auto-link all memories by similarity
ccb link auto

# Background daemon (runs consolidation every hour)
ccb daemon start
ccb daemon status
ccb daemon stop
```

## Steps

1. Run `ccb reflect stats` to see the current state
2. If there are many old memories, run `ccb reflect decay`
3. Check for duplicates with `ccb reflect duplicates`
4. For any duplicates found, decide which to keep and remove the other with `/forget`
5. Run `ccb link auto` to discover new relationships between memories
6. Report a summary of what was found and done
