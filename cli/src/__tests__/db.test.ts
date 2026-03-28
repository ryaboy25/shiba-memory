import { describe, it, expect, afterAll } from "vitest";
import { query, disconnect } from "../db.js";

afterAll(async () => {
  await disconnect();
});

describe("database", () => {
  it("connects and runs a simple query", async () => {
    const result = await query<{ ok: number }>("SELECT 1 AS ok");
    expect(result.rows[0].ok).toBe(1);
  });

  it("has pgvector extension installed", async () => {
    const result = await query<{ extname: string }>(
      "SELECT extname FROM pg_extension WHERE extname = 'vector'"
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].extname).toBe("vector");
  });

  it("has all required tables", async () => {
    const result = await query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename"
    );
    const tables = result.rows.map((r) => r.tablename);
    expect(tables).toContain("memories");
    expect(tables).toContain("memory_links");
    expect(tables).toContain("conversations");
    expect(tables).toContain("events_queue");
    expect(tables).toContain("ingestion_sources");
    expect(tables).toContain("ingestion_log");
    expect(tables).toContain("consolidation_log");
  });

  it("has hybrid_search function", async () => {
    const result = await query<{ proname: string }>(
      "SELECT proname FROM pg_proc WHERE proname = 'hybrid_search'"
    );
    expect(result.rows).toHaveLength(1);
  });

  it("has scoped_recall function", async () => {
    const result = await query<{ proname: string }>(
      "SELECT proname FROM pg_proc WHERE proname = 'scoped_recall'"
    );
    expect(result.rows).toHaveLength(1);
  });

  it("has auto_link_memory function", async () => {
    const result = await query<{ proname: string }>(
      "SELECT proname FROM pg_proc WHERE proname = 'auto_link_memory'"
    );
    expect(result.rows).toHaveLength(1);
  });

  it("has memory_stats function", async () => {
    const result = await query<{ proname: string }>(
      "SELECT proname FROM pg_proc WHERE proname = 'memory_stats'"
    );
    expect(result.rows).toHaveLength(1);
  });
});
