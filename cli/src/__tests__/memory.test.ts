import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { remember } from "../commands/remember.js";
import { recall } from "../commands/recall.js";
import { forget } from "../commands/forget.js";
import { linkMemories, getRelated } from "../commands/link.js";
import { getStats } from "../commands/reflect.js";
import { appendLog, showLog } from "../commands/log.js";
import { query, disconnect } from "../db.js";

// Track IDs for cleanup
const testIds: string[] = [];

afterAll(async () => {
  // Clean up test memories
  for (const id of testIds) {
    await query("DELETE FROM memories WHERE id = $1::uuid", [id]);
  }
  await disconnect();
});

describe("remember", () => {
  it("stores a memory and returns an ID", async () => {
    const id = await remember({
      type: "user",
      title: "Test Memory",
      content: "This is a test memory for the test suite.",
      tags: ["test"],
      importance: 0.5,
      source: "test",
    });
    testIds.push(id);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("stores with profile and project scoping", async () => {
    const id = await remember({
      type: "project",
      title: "Scoped Test Memory",
      content: "This memory is scoped to a project.",
      tags: ["test", "scoped"],
      profile: "project",
      projectPath: "/tmp/test-project",
    });
    testIds.push(id);

    const result = await query<{ profile: string; project_path: string }>(
      "SELECT profile, project_path FROM memories WHERE id = $1::uuid",
      [id]
    );
    expect(result.rows[0].profile).toBe("project");
    expect(result.rows[0].project_path).toBe("/tmp/test-project");
  });

  it("rejects invalid memory types", async () => {
    await expect(
      remember({ type: "invalid", title: "Bad", content: "Bad type" })
    ).rejects.toThrow("Invalid type");
  });
});

describe("recall", () => {
  it("finds memories by semantic search", async () => {
    const results = await recall({ query: "test memory for test suite" });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]).toHaveProperty("id");
    expect(results[0]).toHaveProperty("relevance");
  });

  it("filters by type", async () => {
    const results = await recall({ query: "test", type: "user", limit: 5 });
    results.forEach((r) => expect(r.type).toBe("user"));
  });

  it("filters by tags", async () => {
    const results = await recall({ query: "test", tags: ["scoped"], limit: 5 });
    results.forEach((r) => expect(r.tags).toContain("scoped"));
  });

  it("respects limit", async () => {
    const results = await recall({ query: "test", limit: 1 });
    expect(results.length).toBeLessThanOrEqual(1);
  });

  it("scopes to project", async () => {
    const results = await recall({
      query: "scoped project",
      project: "/tmp/test-project",
      limit: 5,
    });
    // Should include both global and project memories
    expect(results.length).toBeGreaterThan(0);
  });
});

describe("forget", () => {
  it("deletes by ID", async () => {
    const id = await remember({
      type: "episode",
      title: "To Be Deleted",
      content: "This will be deleted.",
      tags: ["test-delete"],
    });

    const count = await forget({ id });
    expect(count).toBe(1);
  });

  it("requires at least one filter", async () => {
    await expect(forget({})).rejects.toThrow("Must specify at least one filter");
  });
});

describe("link", () => {
  it("creates a relationship between memories", async () => {
    if (testIds.length < 2) return;

    await linkMemories(testIds[0], testIds[1], "related", 0.8);

    const links = await getRelated(testIds[0]);
    expect(links.length).toBeGreaterThan(0);
    expect(links.some((l) => l.relation === "related")).toBe(true);
  });
});

describe("stats", () => {
  it("returns brain statistics", async () => {
    const stats = await getStats();
    expect(stats).toHaveProperty("total_memories");
    expect(stats).toHaveProperty("by_type");
    expect(stats).toHaveProperty("with_embeddings");
    expect(stats).toHaveProperty("total_links");
    expect(stats).toHaveProperty("avg_confidence");
  });
});

describe("daily log", () => {
  it("appends and retrieves a log entry", async () => {
    const testDate = "2099-12-31";
    const id = await appendLog("Test log entry for vitest", testDate);
    testIds.push(id);

    const log = await showLog(testDate);
    expect(log).not.toBeNull();
    expect(log!.content).toContain("Test log entry for vitest");
  });
});
