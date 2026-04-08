import { describe, it, expect } from "vitest";
import { getHookEnv, parseStdinJson } from "../hooks/common.js";

describe("hooks/common", () => {
  describe("getHookEnv", () => {
    it("returns session, project, and model info", () => {
      const env = getHookEnv();
      expect(env).toHaveProperty("sessionId");
      expect(env).toHaveProperty("projectDir");
      expect(env).toHaveProperty("model");
      expect(typeof env.sessionId).toBe("string");
      expect(typeof env.projectDir).toBe("string");
    });

    it("generates a session ID when CLAUDE_SESSION_ID is not set", () => {
      delete process.env.CLAUDE_SESSION_ID;
      const env = getHookEnv();
      expect(env.sessionId).toMatch(/^session-\d+$/);
    });
  });

  describe("parseStdinJson", () => {
    it("returns null on empty stdin (TTY)", async () => {
      // In test environment, stdin is typically a TTY
      const result = await parseStdinJson();
      expect(result).toBeNull();
    });
  });
});
