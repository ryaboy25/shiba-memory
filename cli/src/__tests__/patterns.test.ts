import { describe, it, expect } from "vitest";
import { extractPatterns, isCorrection, isDecision } from "../extraction/patterns.js";

describe("Pattern extraction (Tier 1)", () => {
  describe("extractPatterns", () => {
    it("extracts preference statements", () => {
      const facts = extractPatterns("I prefer functional programming over OOP");
      expect(facts.length).toBeGreaterThan(0);
      expect(facts[0].type).toBe("user");
      expect(facts[0].tags).toContain("preference");
    });

    it("extracts correction statements", () => {
      const facts = extractPatterns("Don't use semicolons in TypeScript files");
      expect(facts.length).toBeGreaterThan(0);
      expect(facts[0].type).toBe("feedback");
      expect(facts[0].tags).toContain("correction");
    });

    it("extracts explicit memory requests", () => {
      const facts = extractPatterns("Remember that our API uses JWT tokens for auth");
      expect(facts.length).toBeGreaterThan(0);
      expect(facts[0].tags).toContain("explicit");
    });

    it("extracts identity statements", () => {
      const facts = extractPatterns("I am a senior backend engineer at ACME Corp");
      expect(facts.length).toBeGreaterThan(0);
      expect(facts[0].type).toBe("user");
      expect(facts[0].tags).toContain("identity");
    });

    it("extracts decisions", () => {
      const facts = extractPatterns("Let's go with PostgreSQL for the database");
      expect(facts.length).toBeGreaterThan(0);
      expect(facts[0].type).toBe("project");
      expect(facts[0].tags).toContain("decision");
    });

    it("extracts convention statements", () => {
      const facts = extractPatterns("Our convention is to use camelCase for variables");
      expect(facts.length).toBeGreaterThan(0);
      expect(facts[0].tags).toContain("convention");
    });

    it("ignores assistant messages", () => {
      const facts = extractPatterns("I prefer functional programming", "assistant");
      expect(facts).toHaveLength(0);
    });

    it("ignores very short messages", () => {
      const facts = extractPatterns("ok");
      expect(facts).toHaveLength(0);
    });

    it("deduplicates similar patterns in same message", () => {
      const facts = extractPatterns("I prefer tabs. I always prefer tabs over spaces.");
      // Should not have two "prefer tabs" facts
      const titles = facts.map((f) => f.title.toLowerCase());
      const unique = new Set(titles);
      expect(unique.size).toBe(titles.length);
    });

    it("sets appropriate confidence levels", () => {
      const explicit = extractPatterns("Remember that the API key is in .env");
      const implicit = extractPatterns("I usually use vim for editing");
      if (explicit.length && implicit.length) {
        expect(explicit[0].confidence).toBeGreaterThanOrEqual(implicit[0].confidence);
      }
    });

    it("tags all extractions with tier-1-pattern", () => {
      const facts = extractPatterns("I prefer dark mode in my IDE");
      for (const f of facts) {
        expect(f.tags).toContain("tier-1-pattern");
      }
    });
  });

  describe("isCorrection", () => {
    it("detects 'no' corrections", () => {
      expect(isCorrection("No, that's not right")).toBe(true);
    });

    it("detects 'wrong' corrections", () => {
      expect(isCorrection("Wrong, it should be camelCase")).toBe(true);
    });

    it("detects 'actually' corrections", () => {
      expect(isCorrection("Actually, we use PostgreSQL not MySQL")).toBe(true);
    });

    it("detects 'fix' commands", () => {
      expect(isCorrection("Fix the import path")).toBe(true);
    });

    it("does not flag normal messages", () => {
      expect(isCorrection("Can you help me with this function?")).toBe(false);
    });

    it("does not flag agreement", () => {
      expect(isCorrection("Yes, that looks good")).toBe(false);
    });
  });

  describe("isDecision", () => {
    it("detects 'let's go with' decisions", () => {
      expect(isDecision("Let's go with option B")).toBe(true);
    });

    it("detects 'decided' decisions", () => {
      expect(isDecision("We decided to use React")).toBe(true);
    });

    it("does not flag questions", () => {
      expect(isDecision("Should we use React or Vue?")).toBe(false);
    });
  });
});
