---
name: remember
description: Analyze the current conversation and store important information in Claude Code Brain's persistent memory database
---

# /remember — Store to Long-Term Memory

You have access to a persistent PostgreSQL memory database via the `ccb` CLI tool.

## When to use this

After a conversation contains information worth preserving across sessions:
- User preferences, corrections, or feedback
- Project decisions, architecture choices, deadlines
- Who the user is, their role, expertise
- Pointers to external resources
- Important events or outcomes

## How to store a memory

Run the `ccb remember` command via Bash:

```bash
ccb remember \
  --type <user|feedback|project|reference|episode|skill> \
  --title "Short descriptive title" \
  --content "Detailed content of the memory" \
  --tags tag1 tag2 \
  --importance 0.7 \
  --source skill \
  --profile global \
  --project /path/to/repo
```

### Scoping
- `--profile global` (default) — Memory available everywhere
- `--profile project` — Memory scoped to a project
- `--project /path/to/repo` — Associate with a specific project (gets 1.3x boost when recalled from that project)

## Steps

1. Review the current conversation for information worth remembering
2. Classify each piece of information by type:
   - `user` — who the user is, preferences, expertise
   - `feedback` — corrections, confirmations, behavior guidance
   - `project` — project context, goals, deadlines, decisions
   - `reference` — pointers to external resources (URLs, tools, docs)
   - `episode` — what happened in this conversation (key events/outcomes)
   - `skill` — learned procedures, patterns, or techniques
3. For each memory, determine importance (0.0 = trivial, 1.0 = critical)
4. Store each memory with the `ccb remember` command
5. Report what was stored

## Rules

- **ALWAYS use `ccb remember` to store memories. NEVER write to MEMORY.md or flat markdown files. The database IS the memory system.**
- Do NOT store information that can be derived from code or git history
- Do NOT store temporary or ephemeral task details
- Convert relative dates to absolute dates (e.g. "next Thursday" → "2026-04-02")
- Lead with the fact, then explain why it matters
- One concept per memory — don't combine unrelated information
- Use tags generously for cross-cutting concerns
