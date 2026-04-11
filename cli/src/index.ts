#!/usr/bin/env node

import { Command } from "commander";
import { remember } from "./commands/remember.js";
import { recall } from "./commands/recall.js";
import { forget } from "./commands/forget.js";
import { linkMemories, getRelated, autoLinkAll } from "./commands/link.js";
import { getStats, decayMemories, findDuplicates, consolidate } from "./commands/reflect.js";
import { startDaemon, stopDaemon, daemonStatus } from "./commands/daemon.js";
import { disconnect } from "./db.js";

const program = new Command();

program
  .name("shiba")
  .description("Shiba — Persistent memory for AI agents that learns and never forgets")
  .version("0.1.0");

// Helper: wrap async actions with error handling + disconnect
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function action(fn: (...args: any[]) => Promise<void>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return async (...args: any[]) => {
    try {
      await fn(...args);
    } catch (e: unknown) {
      console.error(JSON.stringify({ status: "error", message: (e as Error).message }));
      process.exitCode = 1;
    } finally {
      await disconnect();
    }
  };
}

// ─── remember ───────────────────────────────────────────────
program
  .command("remember")
  .description("Store a new memory")
  .requiredOption("-t, --type <type>", "Memory type: user, feedback, project, reference, episode, skill")
  .requiredOption("--title <title>", "Short title for the memory")
  .requiredOption("-c, --content <content>", "Memory content")
  .option("--tags <tags...>", "Tags for categorization")
  .option("--importance <n>", "Importance 0.0-1.0", parseFloat)
  .option("--source <source>", "Origin: manual, hook, skill, import")
  .option("--expires-in <duration>", "Auto-expire after duration (e.g. 30d, 24h)")
  .option("--profile <profile>", "Memory profile: global or project", "global")
  .option("--project <path>", "Project path for scoping")
  .action(action(async (opts: Record<string, unknown>) => {
    const id = await remember({
      type: opts.type as string,
      title: opts.title as string,
      content: opts.content as string,
      tags: opts.tags as string[] | undefined,
      importance: opts.importance as number | undefined,
      source: opts.source as string | undefined,
      expiresIn: opts.expiresIn as string | undefined,
      profile: opts.profile as string | undefined,
      projectPath: opts.project as string | undefined,
    });
    console.log(JSON.stringify({ status: "ok", id }));
  }));

// ─── recall ─────────────────────────────────────────────────
program
  .command("recall")
  .description("Search memories using hybrid semantic + full-text search")
  .argument("<query>", "Search query")
  .option("-t, --type <type>", "Filter by memory type")
  .option("--tags <tags...>", "Filter by tags")
  .option("-n, --limit <n>", "Max results", parseInt, 10)
  .option("--semantic-weight <n>", "Semantic search weight 0-1", parseFloat, 0.7)
  .option("--fulltext-weight <n>", "Full-text search weight 0-1", parseFloat, 0.3)
  .option("--profile <profile>", "Scope to profile")
  .option("--project <path>", "Scope to project path")
  .action(action(async (queryText: string, opts: Record<string, unknown>) => {
    const results = await recall({
      query: queryText,
      type: opts.type as string | undefined,
      tags: opts.tags as string[] | undefined,
      limit: opts.limit as number,
      semanticWeight: opts.semanticWeight as number,
      fulltextWeight: opts.fulltextWeight as number,
      profile: opts.profile as string | undefined,
      project: opts.project as string | undefined,
    });
    console.log(JSON.stringify({ status: "ok", count: results.length, memories: results }));
  }));

// ─── forget ─────────────────────────────────────────────────
program
  .command("forget")
  .description("Delete memories by ID or criteria")
  .option("--id <uuid>", "Delete a specific memory by ID")
  .option("-t, --type <type>", "Delete all of a type")
  .option("--older-than <duration>", "Delete older than (e.g. 90d)")
  .option("--low-confidence <n>", "Delete below confidence threshold", parseFloat)
  .option("--expired", "Clean up all expired memories")
  .action(action(async (opts: Record<string, unknown>) => {
    const count = await forget({
      id: opts.id as string | undefined,
      type: opts.type as string | undefined,
      olderThan: opts.olderThan as string | undefined,
      lowConfidence: opts.lowConfidence as number | undefined,
      expired: opts.expired as boolean | undefined,
    });
    console.log(JSON.stringify({ status: "ok", deleted: count }));
  }));

// ─── link ───────────────────────────────────────────────────
const linkCmd = program
  .command("link")
  .description("Manage memory relationships");

linkCmd
  .command("create")
  .description("Link two memories")
  .argument("<source-id>", "Source memory UUID")
  .argument("<target-id>", "Target memory UUID")
  .argument("<relation>", "Relation: related, supports, contradicts, supersedes, caused_by, derived_from")
  .option("-s, --strength <n>", "Link strength 0-1", parseFloat, 0.5)
  .action(action(async (sourceId: string, targetId: string, relation: string, opts: Record<string, unknown>) => {
    await linkMemories(sourceId, targetId, relation, opts.strength as number);
    console.log(JSON.stringify({ status: "ok" }));
  }));

linkCmd
  .command("show")
  .description("Show all relationships for a memory")
  .argument("<memory-id>", "Memory UUID")
  .action(action(async (memoryId: string) => {
    const links = await getRelated(memoryId);
    console.log(JSON.stringify({ status: "ok", links }));
  }));

linkCmd
  .command("auto")
  .description("Auto-link all memories by semantic similarity")
  .action(action(async () => {
    const count = await autoLinkAll();
    console.log(JSON.stringify({ status: "ok", links_created: count }));
  }));

// ─── reflect ────────────────────────────────────────────────
const reflectCmd = program
  .command("reflect")
  .description("Memory maintenance — stats, decay, dedup, consolidation");

reflectCmd
  .command("stats")
  .description("Show memory statistics")
  .action(action(async () => {
    const stats = await getStats();
    console.log(JSON.stringify({ status: "ok", ...stats }));
  }));

reflectCmd
  .command("decay")
  .description("Decay old, unused memories and clean up expired ones")
  .action(action(async () => {
    const result = await decayMemories();
    console.log(JSON.stringify({ status: "ok", ...result }));
  }));

reflectCmd
  .command("duplicates")
  .description("Find near-duplicate memories")
  .action(action(async () => {
    const dupes = await findDuplicates();
    console.log(JSON.stringify({ status: "ok", count: dupes.length, duplicates: dupes }));
  }));

reflectCmd
  .command("consolidate")
  .description("Full brain maintenance: merge dupes, find contradictions, decay, link, generate insights")
  .action(action(async () => {
    const result = await consolidate();
    console.log(JSON.stringify({ status: "ok", ...result }));
  }));

// ─── ingest ─────────────────────────────────────────────────
const ingestCmd = program
  .command("ingest")
  .description("Ingest external knowledge into the brain");

ingestCmd
  .command("web")
  .description("Ingest a web page")
  .argument("<url>", "URL to fetch and store")
  .option("--tags <tags...>", "Additional tags")
  .option("--dry-run", "Show what would be stored without storing")
  .action(action(async (url: string, opts: Record<string, unknown>) => {
    const { ingestWeb } = await import("./commands/ingest/web.js");
    const result = await ingestWeb(url, {
      dryRun: opts.dryRun as boolean | undefined,
      tags: opts.tags as string[] | undefined,
    });
    console.log(JSON.stringify({ status: "ok", ...result }));
  }));

ingestCmd
  .command("rss")
  .description("Ingest an RSS feed")
  .argument("<feed-url>", "RSS feed URL")
  .option("--name <name>", "Feed name")
  .option("--tags <tags...>", "Additional tags")
  .option("--dry-run", "Show what would be stored without storing")
  .action(action(async (feedUrl: string, opts: Record<string, unknown>) => {
    const { ingestRss } = await import("./commands/ingest/rss.js");
    const result = await ingestRss(feedUrl, {
      name: opts.name as string | undefined,
      dryRun: opts.dryRun as boolean | undefined,
      tags: opts.tags as string[] | undefined,
    });
    console.log(JSON.stringify({ status: "ok", ...result }));
  }));

ingestCmd
  .command("git")
  .description("Ingest git history from a repo")
  .argument("[path]", "Repo path (default: cwd)", ".")
  .option("-n, --limit <n>", "Max commits", parseInt, 50)
  .option("--dry-run", "Show what would be stored without storing")
  .action(action(async (path: string, opts: Record<string, unknown>) => {
    const { ingestGit } = await import("./commands/ingest/git.js");
    const result = await ingestGit(path, {
      dryRun: opts.dryRun as boolean | undefined,
      limit: opts.limit as number | undefined,
    });
    console.log(JSON.stringify({ status: "ok", ...result }));
  }));

ingestCmd
  .command("file")
  .description("Ingest a file or directory")
  .argument("<path>", "File or directory path")
  .option("--tags <tags...>", "Additional tags")
  .option("--dry-run", "Show what would be stored without storing")
  .action(action(async (path: string, opts: Record<string, unknown>) => {
    const { ingestFile } = await import("./commands/ingest/file.js");
    const result = await ingestFile(path, {
      dryRun: opts.dryRun as boolean | undefined,
      tags: opts.tags as string[] | undefined,
    });
    console.log(JSON.stringify({ status: "ok", ...result }));
  }));

ingestCmd
  .command("news")
  .description("Ingest AI/tech news from preconfigured RSS feeds")
  .option("--dry-run", "Show what would be stored without storing")
  .action(action(async (opts: Record<string, unknown>) => {
    const { ingestNews } = await import("./commands/ingest/news.js");
    const result = await ingestNews({
      dryRun: opts.dryRun as boolean | undefined,
    });
    console.log(JSON.stringify({ status: "ok", ...result }));
  }));

// ─── daemon ─────────────────────────────────────────────────
const daemonCmd = program
  .command("daemon")
  .description("Background brain service for periodic consolidation");

daemonCmd
  .command("start")
  .description("Start the background daemon")
  .action(() => {
    startDaemon();
  });

daemonCmd
  .command("stop")
  .description("Stop the background daemon")
  .action(() => {
    const result = stopDaemon();
    console.log(JSON.stringify({ status: "ok", ...result }));
  });

daemonCmd
  .command("status")
  .description("Check daemon status")
  .action(() => {
    const result = daemonStatus();
    console.log(JSON.stringify({ status: "ok", ...result }));
  });

// ─── gateway ────────────────────────────────────────────────
const gatewayCmd = program
  .command("gateway")
  .description("Always-on HTTP brain server for external integrations");

gatewayCmd
  .command("start")
  .description("Start the gateway server")
  .action(async () => {
    const { startGateway } = await import("./commands/gateway.js");
    startGateway();
  });

gatewayCmd
  .command("stop")
  .description("Stop the gateway server")
  .action(async () => {
    const { stopGateway } = await import("./commands/gateway.js");
    const result = stopGateway();
    console.log(JSON.stringify({ status: "ok", ...result }));
  });

gatewayCmd
  .command("status")
  .description("Check gateway status")
  .action(async () => {
    const { gatewayStatus } = await import("./commands/gateway.js");
    const result = gatewayStatus();
    console.log(JSON.stringify({ status: "ok", ...result }));
  });

// ─── evolve ─────────────────────────────────────────────────
program
  .command("evolve")
  .description("Evolve high-confidence instincts into learned skills")
  .action(action(async () => {
    const { evolve } = await import("./commands/evolve.js");
    const result = await evolve();
    console.log(JSON.stringify({ status: "ok", ...result }));
  }));

// ─── track ──────────────────────────────────────────────────
const trackCmd = program
  .command("track")
  .description("Progress tracking for long-running tasks");

trackCmd
  .command("create")
  .description("Create a progress tracker")
  .argument("<project>", "Project name")
  .option("--features <features...>", "Initial features to track")
  .action(action(async (project: string, opts: Record<string, unknown>) => {
    const { createTracker } = await import("./commands/track.js");
    const id = await createTracker(project, (opts.features as string[]) || []);
    console.log(JSON.stringify({ status: "ok", id }));
  }));

trackCmd
  .command("update")
  .description("Update a feature status")
  .argument("<project>", "Project name")
  .argument("<feature>", "Feature name")
  .option("-s, --status <status>", "Status: todo, in_progress, done, blocked", "done")
  .option("--notes <notes>", "Optional notes")
  .action(action(async (project: string, feature: string, opts: Record<string, unknown>) => {
    const { updateTracker } = await import("./commands/track.js");
    const tracker = await updateTracker(project, feature, opts.status as string, opts.notes as string | undefined);
    if (!tracker) {
      console.log(JSON.stringify({ status: "error", message: "Tracker not found" }));
    } else {
      const done = tracker.features.filter((f) => f.status === "done").length;
      console.log(JSON.stringify({ status: "ok", progress: `${done}/${tracker.features.length}`, tracker }));
    }
  }));

trackCmd
  .command("show")
  .description("Show progress trackers")
  .argument("[project]", "Filter by project name")
  .action(action(async (project?: string) => {
    const { showTracker } = await import("./commands/track.js");
    const trackers = await showTracker(project);
    console.log(JSON.stringify({ status: "ok", count: trackers.length, trackers }));
  }));

// ─── log ────────────────────────────────────────────────────
const logCmd = program
  .command("log")
  .description("Daily working memory log");

logCmd
  .command("add")
  .description("Append a note to today's log")
  .argument("<note>", "Note to add")
  .action(action(async (note: string) => {
    const { appendLog } = await import("./commands/log.js");
    const id = await appendLog(note);
    console.log(JSON.stringify({ status: "ok", id }));
  }));

logCmd
  .command("show")
  .description("Show a day's log")
  .argument("[date]", "Date in YYYY-MM-DD format (default: today)")
  .action(action(async (date?: string) => {
    const { showLog } = await import("./commands/log.js");
    const log = await showLog(date);
    if (!log) {
      console.log(JSON.stringify({ status: "ok", message: "No log for this date" }));
    } else {
      console.log(JSON.stringify({ status: "ok", ...log }));
    }
  }));

logCmd
  .command("recent")
  .description("Show recent daily logs")
  .option("-n, --days <n>", "Number of days", parseInt, 3)
  .action(action(async (opts: Record<string, unknown>) => {
    const { recentLogs } = await import("./commands/log.js");
    const logs = await recentLogs(opts.days as number);
    console.log(JSON.stringify({ status: "ok", count: logs.length, logs }));
  }));

// ─── setup ──────────────────────────────────────────────────
program
  .command("setup")
  .description("Interactive setup wizard — configure brain, enter your profile, scan repos")
  .action(async () => {
    const { runSetup } = await import("./commands/setup.js");
    await runSetup();
  });

// ─── health ─────────────────────────────────────────────────
program
  .command("health")
  .description("Check database connectivity and schema")
  .action(action(async () => {
    const { query: q } = await import("./db.js");
    const dbCheck = await q("SELECT 1 AS ok");
    const extCheck = await q<{ extname: string }>(
      "SELECT extname FROM pg_extension WHERE extname IN ('vector', 'uuid-ossp') ORDER BY extname"
    );
    const tableCheck = await q<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename"
    );
    console.log(JSON.stringify({
      status: "ok",
      database: dbCheck.rows.length > 0,
      extensions: extCheck.rows.map((r) => r.extname),
      tables: tableCheck.rows.map((r) => r.tablename),
    }));
  }));

// ─── migrate ───────────────────────────────────────────────
program
  .command("migrate")
  .description("Run pending database migrations from schema/ directory")
  .action(action(async () => {
    const { migrate: runMigrate } = await import("./commands/migrate.js");
    const result = await runMigrate();
    console.log(JSON.stringify({
      status: "ok",
      applied: result.applied,
      skipped: result.skipped,
      message: result.applied.length > 0
        ? `Applied ${result.applied.length} migration(s)`
        : "Database is up to date",
    }));
  }));

// ─── materialize ───────────────────────────────────────────
program
  .command("materialize")
  .description("Generate .shiba/ files from database memories for the current project")
  .option("--project <path>", "Project path to scope memories to")
  .option("--output <dir>", "Output directory (default: cwd)")
  .action(action(async (opts: Record<string, unknown>) => {
    const { materialize } = await import("./commands/materialize.js");
    const result = await materialize({
      projectPath: opts.project as string | undefined,
      outputDir: opts.output as string | undefined,
    });
    console.log(JSON.stringify({
      status: "ok",
      dir: result.dir,
      files: result.files,
      total_memories: result.totalMemories,
    }));
  }));

// ─── compile ──────────────────────────────────────────────
program
  .command("compile")
  .description("Compile episodic memories into structured knowledge articles")
  .option("--project <path>", "Scope to a project")
  .action(action(async (opts: Record<string, unknown>) => {
    const { compile } = await import("./commands/compile.js");
    const result = await compile(opts.project as string | undefined);
    console.log(JSON.stringify({
      status: "ok",
      articles_created: result.articles_created,
      episodes_processed: result.episodes_processed,
      tokens_used: result.tokens_used,
    }));
  }));

// ─── entity ───────────────────────────────────────────────
const entityCmd = program
  .command("entity")
  .description("Entity resolution — track people, pets, orgs, and concepts across memories");

entityCmd
  .command("create")
  .description("Create or update an entity")
  .argument("<name>", "Canonical name")
  .option("-t, --type <type>", "Entity type: person, pet, org, place, tool, concept", "unknown")
  .option("--aliases <aliases...>", "Alternative names/references")
  .action(action(async (name: string, opts: Record<string, unknown>) => {
    const { upsertEntity } = await import("./commands/entity.js");
    const id = await upsertEntity({
      name,
      type: opts.type as string,
      aliases: opts.aliases as string[] | undefined,
    });
    console.log(JSON.stringify({ status: "ok", id }));
  }));

entityCmd
  .command("list")
  .description("List all known entities")
  .option("-t, --type <type>", "Filter by entity type")
  .action(action(async (opts: Record<string, unknown>) => {
    const { listEntities } = await import("./commands/entity.js");
    const entities = await listEntities({ type: opts.type as string | undefined });
    console.log(JSON.stringify({ status: "ok", count: entities.length, entities }));
  }));

entityCmd
  .command("recall")
  .description("Find all memories about a specific entity")
  .argument("<name>", "Entity name or alias")
  .option("-n, --limit <n>", "Max results", parseInt, 20)
  .action(action(async (name: string, opts: Record<string, unknown>) => {
    const { recallByEntity } = await import("./commands/entity.js");
    const result = await recallByEntity(name, { limit: opts.limit as number });
    console.log(JSON.stringify({ status: "ok", ...result }));
  }));

entityCmd
  .command("merge")
  .description("Merge two entities (source → target)")
  .argument("<source>", "Source entity UUID (will be deleted)")
  .argument("<target>", "Target entity UUID (will absorb aliases)")
  .action(action(async (source: string, target: string) => {
    const { mergeEntities } = await import("./commands/entity.js");
    await mergeEntities(source, target);
    console.log(JSON.stringify({ status: "ok", message: `Merged ${source} into ${target}` }));
  }));

// ─── mcp ──────────────────────────────────────────────────
const mcpCmd = program
  .command("mcp")
  .description("MCP (Model Context Protocol) server for AI agent integrations");

mcpCmd
  .command("start")
  .description("Start MCP server on stdio (connect from Claude Desktop, Cursor, etc.)")
  .action(async () => {
    const { startMCPServer } = await import("./commands/mcp.js");
    startMCPServer();
  });

// ─── dashboard ─────────────────────────────────────────────
program
  .command("dashboard")
  .description("Launch the Shiba Memory 3D brain dashboard")
  .option("-p, --port <port>", "Dashboard port", "3001")
  .action(async (opts: Record<string, unknown>) => {
    const { execSync } = await import("child_process");
    const { resolve } = await import("path");
    const { fileURLToPath } = await import("url");
    const __dir = resolve(fileURLToPath(import.meta.url), "..");
    const dashboardDir = resolve(__dir, "../../dashboard");
    const port = String(opts.port).replace(/[^0-9]/g, "") || "3001"; // sanitize port
    console.log(`Starting Shiba Dashboard on http://localhost:${port}`);
    try {
      execSync(`npm run dev -- -p ${port}`, { cwd: dashboardDir, stdio: "inherit" });
    } catch {
      console.error("Dashboard failed to start. Run 'cd dashboard && npm install' first.");
    }
  });

program.parse();
