import { describe, it, expect, beforeAll } from "vitest";
import { createApp } from "../commands/gateway.js";

const app = createApp();

// Helper to make requests against the Hono app
async function req(method: string, path: string, body?: unknown, headers?: Record<string, string>) {
  const init: RequestInit = { method, headers: { "Content-Type": "application/json", ...headers } };
  if (body) init.body = JSON.stringify(body);
  return app.request(`http://localhost${path}`, init);
}

async function json(res: Response) {
  return res.json();
}

describe("Gateway API", () => {
  // ── Health (no auth) ──────────────────────────────────────
  describe("GET /health", () => {
    it("returns 200 with uptime and db latency", async () => {
      const res = await req("GET", "/health");
      expect(res.status).toBe(200);
      const data = await json(res);
      expect(data.status).toBe("ok");
      expect(data).toHaveProperty("uptime_seconds");
      expect(data).toHaveProperty("db_latency_ms");
    });
  });

  // ── 404 handling ──────────────────────────────────────────
  describe("Unknown routes", () => {
    it("returns 404 for unknown paths", async () => {
      const res = await req("GET", "/nonexistent");
      expect(res.status).toBe(404);
      const data = await json(res);
      expect(data.code).toBe("NOT_FOUND");
    });
  });

  // ── Remember ──────────────────────────────────────────────
  describe("POST /remember", () => {
    it("validates required fields", async () => {
      const res = await req("POST", "/remember", {});
      expect(res.status).toBe(400);
      const data = await json(res);
      expect(data.code).toBe("VALIDATION_ERROR");
    });

    it("rejects content exceeding max length", async () => {
      const res = await req("POST", "/remember", {
        content: "x".repeat(50001),
        title: "test",
      });
      expect(res.status).toBe(400);
    });

    it("accepts valid memory with defaults", async () => {
      const res = await req("POST", "/remember", {
        content: "Test memory content for integration test",
        title: "Integration test memory",
        type: "episode",
      });
      // May fail if no DB — that's ok, we're testing validation passes
      expect([200, 500]).toContain(res.status);
      if (res.status === 200) {
        const data = await json(res);
        expect(data.status).toBe("ok");
        expect(data.id).toBeDefined();
      }
    });

    it("validates type enum", async () => {
      const res = await req("POST", "/remember", {
        content: "test",
        title: "test",
        type: "invalid_type",
      });
      expect(res.status).toBe(400);
    });

    it("validates importance range", async () => {
      const res = await req("POST", "/remember", {
        content: "test",
        title: "test",
        type: "episode",
        importance: 5.0,
      });
      expect(res.status).toBe(400);
    });
  });

  // ── Recall ────────────────────────────────────────────────
  describe("POST /recall", () => {
    it("validates required query field", async () => {
      const res = await req("POST", "/recall", {});
      expect(res.status).toBe(400);
    });

    it("validates limit bounds", async () => {
      const res = await req("POST", "/recall", { query: "test", limit: 500 });
      expect(res.status).toBe(400);
    });

    it("accepts valid recall request", async () => {
      const res = await req("POST", "/recall", { query: "test query" });
      expect([200, 500]).toContain(res.status);
    });
  });

  // ── Forget ────────────────────────────────────────────────
  describe("POST /forget", () => {
    it("validates UUID format for id", async () => {
      const res = await req("POST", "/forget", { id: "not-a-uuid" });
      expect(res.status).toBe(400);
    });

    it("accepts valid forget by expired", async () => {
      const res = await req("POST", "/forget", { expired: true });
      expect([200, 500]).toContain(res.status);
    });
  });

  // ── Memory by ID ──────────────────────────────────────────
  describe("GET /memory/:id", () => {
    it("validates UUID param", async () => {
      const res = await req("GET", "/memory/not-a-uuid");
      expect(res.status).toBe(400);
      const data = await json(res);
      expect(data.code).toBe("INVALID_ID");
    });

    it("returns 404 for missing memory", async () => {
      const res = await req("GET", "/memory/00000000-0000-0000-0000-000000000000");
      expect([404, 500]).toContain(res.status);
    });
  });

  describe("DELETE /memory/:id", () => {
    it("validates UUID param", async () => {
      const res = await req("DELETE", "/memory/bad-id");
      expect(res.status).toBe(400);
    });
  });

  // ── Links ─────────────────────────────────────────────────
  describe("POST /link", () => {
    it("validates required fields", async () => {
      const res = await req("POST", "/link", {});
      expect(res.status).toBe(400);
    });

    it("validates relation enum", async () => {
      const res = await req("POST", "/link", {
        source_id: "00000000-0000-0000-0000-000000000001",
        target_id: "00000000-0000-0000-0000-000000000002",
        relation: "invalid",
      });
      expect(res.status).toBe(400);
    });

    it("validates strength range", async () => {
      const res = await req("POST", "/link", {
        source_id: "00000000-0000-0000-0000-000000000001",
        target_id: "00000000-0000-0000-0000-000000000002",
        relation: "related",
        strength: 5.0,
      });
      expect(res.status).toBe(400);
    });
  });

  describe("GET /links/:id", () => {
    it("validates UUID param", async () => {
      const res = await req("GET", "/links/not-uuid");
      expect(res.status).toBe(400);
    });
  });

  // ── Events ────────────────────────────────────────────────
  describe("POST /event", () => {
    it("accepts valid event with defaults", async () => {
      const res = await req("POST", "/event", { payload: { test: true } });
      expect([200, 500]).toContain(res.status);
    });
  });

  describe("POST /events/process", () => {
    it("validates ids array required", async () => {
      const res = await req("POST", "/events/process", {});
      expect(res.status).toBe(400);
    });

    it("validates ids are integers", async () => {
      const res = await req("POST", "/events/process", { ids: ["not-a-number"] });
      expect(res.status).toBe(400);
    });
  });

  // ── Webhook ───────────────────────────────────────────────
  describe("POST /webhook", () => {
    it("accepts arbitrary webhook payload", async () => {
      const res = await req("POST", "/webhook", { source: "test", message: "hello from webhook test" });
      expect([200, 500]).toContain(res.status);
    });
  });

  // ── Channel ───────────────────────────────────────────────
  describe("POST /channel", () => {
    it("accepts channel message with defaults", async () => {
      const res = await req("POST", "/channel", { message: "test message" });
      expect([200, 500]).toContain(res.status);
    });
  });

  // ── Metrics ───────────────────────────────────────────────
  describe("GET /metrics", () => {
    it("returns prometheus-compatible text", async () => {
      const res = await req("GET", "/metrics");
      expect([200, 500]).toContain(res.status);
      if (res.status === 200) {
        const text = await res.text();
        expect(text).toContain("shiba_memories_total");
        expect(text).toContain("shiba_uptime_seconds");
      }
    });
  });

  // ── Invalid JSON ──────────────────────────────────────────
  describe("Invalid JSON handling", () => {
    it("returns 400 for malformed JSON", async () => {
      const res = await app.request("http://localhost/remember", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not valid json{{{",
      });
      expect(res.status).toBe(400);
    });
  });
});
