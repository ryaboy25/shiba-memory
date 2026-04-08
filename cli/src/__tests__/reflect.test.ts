import { describe, it, expect, afterAll } from "vitest";
import { query, disconnect } from "../db.js";
import { getStats, decayMemories, findDuplicates } from "../commands/reflect.js";

afterAll(async () => {
  await disconnect();
});

describe("reflect", () => {
  describe("getStats", () => {
    it("returns memory statistics", async () => {
      const stats = await getStats();
      expect(stats).toHaveProperty("total_memories");
      expect(stats).toHaveProperty("by_type");
      expect(stats).toHaveProperty("with_embeddings");
      expect(stats).toHaveProperty("total_links");
      expect(stats).toHaveProperty("avg_confidence");
    });
  });

  describe("findDuplicates", () => {
    it("returns array of duplicate pairs", async () => {
      const dupes = await findDuplicates();
      expect(Array.isArray(dupes)).toBe(true);
      for (const d of dupes) {
        expect(d).toHaveProperty("id1");
        expect(d).toHaveProperty("id2");
        expect(d).toHaveProperty("similarity");
        expect(d.similarity).toBeGreaterThan(0.92);
      }
    });
  });

  describe("decayMemories", () => {
    it("returns decay and expired counts", async () => {
      const result = await decayMemories();
      expect(result).toHaveProperty("decayed");
      expect(result).toHaveProperty("expired");
      expect(typeof result.decayed).toBe("number");
      expect(typeof result.expired).toBe("number");
    });
  });
});
