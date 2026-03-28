---
name: ingest
description: Ingest external knowledge into Claude Code Brain — web pages, RSS feeds, git history, files, AI news
---

# /ingest — Feed the Brain

You have access to a persistent PostgreSQL memory database via the `ccb` CLI tool. Use the ingest commands to absorb external knowledge.

## Commands

### Web page
```bash
ccb ingest web <url> [--tags tag1 tag2] [--dry-run]
```
Fetches a URL, strips HTML, chunks the content, and stores as reference memories.

### RSS feed
```bash
ccb ingest rss <feed-url> [--name "Feed Name"] [--tags tag1] [--dry-run]
```
Parses an RSS/Atom feed and stores each item as a reference memory. Tracks what's been ingested to avoid duplicates on re-runs.

### Git history
```bash
ccb ingest git [path] [--limit 50] [--dry-run]
```
Scans git log of a repo (default: current directory) and stores commit history as project-scoped episode memories. Groups commits into batches of 10.

### File or directory
```bash
ccb ingest file <path> [--tags tag1] [--dry-run]
```
Reads text files (md, txt, json, yaml, code files) and stores them as reference memories. For directories, recursively collects up to 100 files.

### AI/tech news
```bash
ccb ingest news [--dry-run]
```
Fetches from preconfigured AI news feeds (Anthropic, OpenAI, Google AI, Hacker News) and stores new items. News memories auto-expire after 90 days.

## When to use this

- When the user mentions a URL that contains useful reference information
- When starting work on a new project — run `ccb ingest git .` to load history
- Periodically run `ccb ingest news` to stay current on AI developments
- When the user shares docs or notes they want the brain to know about

## Rules

- Always use `--dry-run` first if unsure about what will be stored
- All ingestion is deduplicated — safe to re-run
- News items expire after 90 days; git episodes after 60 days
- Web pages are stored permanently as reference memories
