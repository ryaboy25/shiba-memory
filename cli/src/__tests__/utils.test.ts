import { describe, it, expect } from "vitest";
import { maskSecrets } from "../utils/secrets.js";
import { contentHash } from "../utils/hash.js";
import { chunkText } from "../utils/chunker.js";
import { detectProject } from "../utils/project.js";

describe("secrets", () => {
  it("masks OpenAI API keys", () => {
    const input = "my key is sk-abc123456789012345678901234567890";
    expect(maskSecrets(input)).toContain("***MASKED***");
    expect(maskSecrets(input)).not.toContain("sk-abc");
  });

  it("masks GitHub tokens", () => {
    const input = "token: ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx1234";
    expect(maskSecrets(input)).toContain("***MASKED***");
    expect(maskSecrets(input)).not.toContain("ghp_");
  });

  it("masks Bearer tokens", () => {
    const input = "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature";
    expect(maskSecrets(input)).toContain("***MASKED***");
  });

  it("masks connection strings", () => {
    const input = "DATABASE_URL=postgresql://user:s3cret@localhost:5432/db";
    expect(maskSecrets(input)).toContain("***MASKED***");
    expect(maskSecrets(input)).not.toContain("s3cret");
  });

  it("masks KEY=value patterns", () => {
    const input = "API_KEY=abcdef123456789012345678";
    expect(maskSecrets(input)).toContain("***MASKED***");
  });

  it("leaves normal text alone", () => {
    const input = "This is a normal sentence about databases.";
    expect(maskSecrets(input)).toBe(input);
  });
});

describe("hash", () => {
  it("returns consistent SHA-256 hex", () => {
    const hash1 = contentHash("hello world");
    const hash2 = contentHash("hello world");
    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(64);
  });

  it("different input produces different hash", () => {
    expect(contentHash("hello")).not.toBe(contentHash("world"));
  });
});

describe("chunker", () => {
  it("returns single chunk for short text", () => {
    const chunks = chunkText("Short text.", 2000);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe("Short text.");
  });

  it("splits at paragraph boundaries", () => {
    const text = "Paragraph one.\n\nParagraph two.\n\nParagraph three.";
    const chunks = chunkText(text, 30, 0);
    expect(chunks.length).toBeGreaterThan(1);
  });

  it("handles very long single paragraphs", () => {
    const longPara = "Word ".repeat(1000);
    const chunks = chunkText(longPara, 200, 0);
    expect(chunks.length).toBeGreaterThan(1);
    chunks.forEach((c) => expect(c.length).toBeLessThanOrEqual(250)); // some flex for sentence splits
  });

  it("returns empty array elements for empty input", () => {
    const chunks = chunkText("");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe("");
  });
});

describe("project", () => {
  it("detects project name from git repo path", () => {
    const name = detectProject("/mnt/c/Users/Ryabo/source/repos/shiba-memory");
    expect(name).toBe("shiba-memory");
  });

  it("falls back to basename for non-git directory", () => {
    const name = detectProject("/tmp");
    expect(name).toBe("tmp");
  });
});
