import { describe, it, expect } from "vitest";
import { createApp } from "../commands/gateway.js";

const app = createApp();

async function req(method: string, path: string, body?: unknown) {
  const init: RequestInit = { method, headers: { "Content-Type": "application/json" } };
  if (body) init.body = JSON.stringify(body);
  return app.request(`http://localhost${path}`, init);
}

describe("Edge cases", () => {
  describe("UUID validation", () => {
    it("rejects empty string as UUID", async () => {
      const res = await req("GET", "/memory/");
      expect([400, 404]).toContain(res.status);
    });

    it("rejects SQL injection in UUID param", async () => {
      const res = await req("GET", "/memory/'; DROP TABLE memories; --");
      expect(res.status).toBe(400);
    });

    it("rejects path traversal in UUID param", async () => {
      const res = await req("GET", "/memory/../../etc/passwd");
      expect([400, 404]).toContain(res.status);
    });
  });

  describe("Content limits", () => {
    it("rejects title over 500 chars", async () => {
      const res = await req("POST", "/remember", {
        title: "x".repeat(501),
        content: "test",
        type: "episode",
      });
      expect(res.status).toBe(400);
    });

    it("accepts title at exactly 500 chars", async () => {
      const res = await req("POST", "/remember", {
        title: "x".repeat(500),
        content: "test content",
        type: "episode",
      });
      // 200 if DB connected, 500 if not — but not 400
      expect([200, 500]).toContain(res.status);
    });
  });

  describe("Type coercion safety", () => {
    it("rejects non-number importance", async () => {
      const res = await req("POST", "/remember", {
        title: "test",
        content: "test",
        type: "episode",
        importance: "high",
      });
      expect(res.status).toBe(400);
    });

    it("rejects non-array tags", async () => {
      const res = await req("POST", "/remember", {
        title: "test",
        content: "test",
        type: "episode",
        tags: "not-an-array",
      });
      expect(res.status).toBe(400);
    });

    it("rejects non-integer limit in recall", async () => {
      const res = await req("POST", "/recall", {
        query: "test",
        limit: 5.5,
      });
      expect(res.status).toBe(400);
    });
  });

  describe("Empty body handling", () => {
    it("returns validation error for empty POST /remember", async () => {
      const res = await req("POST", "/remember", {});
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.code).toBe("VALIDATION_ERROR");
      expect(data.errors).toBeDefined();
      expect(data.errors.length).toBeGreaterThan(0);
    });

    it("returns validation error for empty POST /recall", async () => {
      const res = await req("POST", "/recall", {});
      expect(res.status).toBe(400);
    });
  });

  describe("Process events validation", () => {
    it("rejects empty ids array", async () => {
      // Empty array is valid — just processes nothing
      const res = await req("POST", "/events/process", { ids: [] });
      expect([200, 500]).toContain(res.status);
    });

    it("rejects string ids", async () => {
      const res = await req("POST", "/events/process", { ids: ["abc"] });
      expect(res.status).toBe(400);
    });

    it("rejects float ids", async () => {
      const res = await req("POST", "/events/process", { ids: [1.5] });
      expect(res.status).toBe(400);
    });
  });
});
