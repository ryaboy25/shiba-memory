---
name: forget
description: Remove outdated or incorrect memories from Claude Code Brain's database
---

# /forget — Remove Memories

You have access to a persistent PostgreSQL memory database via the `ccb` CLI tool.

## When to use this

- When a memory is confirmed to be wrong or outdated
- When the user asks you to forget something
- When cleaning up stale project context after a project wraps up
- During maintenance to remove low-confidence or expired memories

## How to forget

```bash
# Delete a specific memory by ID
ccb forget --id <uuid>

# Delete all expired memories
ccb forget --expired

# Delete old memories of a type
ccb forget --type episode --older-than 90d

# Delete low-confidence memories
ccb forget --low-confidence 0.1
```

## Steps

1. If the user asks to forget something specific, first run `/recall` to find the memory
2. Confirm what will be deleted before running the command
3. Run `ccb forget` with the appropriate filters
4. Report what was removed

## Rules

- Always confirm before bulk deletions (--type, --older-than, --low-confidence)
- For a single memory, delete by --id is preferred
- When the user says "forget X", find the specific memory first rather than guessing
