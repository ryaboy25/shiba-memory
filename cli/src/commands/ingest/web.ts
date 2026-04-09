import { registerSource, ingestChunk, updateLastIngested } from "./common.js";
import { chunkText } from "../../utils/chunker.js";

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[\s\S]*?<\/nav>/gi, "")
    .replace(/<footer[\s\S]*?<\/footer>/gi, "")
    .replace(/<header[\s\S]*?<\/header>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function validateUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }

  // Only allow http/https
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(`Blocked protocol: ${parsed.protocol}. Only http/https allowed.`);
  }

  // Block private/internal IPs
  const hostname = parsed.hostname.toLowerCase();
  const blocked = [
    /^localhost$/,
    /^127\./,
    /^10\./,
    /^172\.(1[6-9]|2\d|3[01])\./,
    /^192\.168\./,
    /^0\./,
    /^169\.254\./,   // link-local
    /^\[::1\]$/,     // IPv6 loopback
    /^\[fc/,         // IPv6 private
    /^\[fd/,         // IPv6 private
    /^metadata\./,   // cloud metadata endpoints
  ];

  if (blocked.some((r) => r.test(hostname))) {
    throw new Error(`Blocked host: ${hostname}. Cannot access internal/private addresses.`);
  }
}

export async function ingestWeb(
  url: string,
  opts: { dryRun?: boolean; tags?: string[] } = {}
): Promise<{ stored: number; skipped: number }> {
  validateUrl(url);

  const sourceId = await registerSource("web", url, url);

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);

  const html = await res.text();
  const text = stripHtml(html);

  if (text.length < 100) {
    throw new Error("Page content too short after HTML stripping");
  }

  // Extract title from HTML
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  const pageTitle = titleMatch?.[1]?.trim() || new URL(url).hostname;

  const chunks = chunkText(text);
  let stored = 0;
  let skipped = 0;

  for (let i = 0; i < chunks.length; i++) {
    const title = chunks.length === 1
      ? pageTitle
      : `${pageTitle} (${i + 1}/${chunks.length})`;

    const result = await ingestChunk(title, chunks[i], {
      type: "reference",
      tags: ["web", ...(opts.tags || [])],
      source: "ingest",
      importance: 0.4,
      dryRun: opts.dryRun,
    }, sourceId);

    if (result.skipped) skipped++;
    else stored++;
  }

  if (!opts.dryRun) {
    await updateLastIngested(sourceId);
  }

  return { stored, skipped };
}
