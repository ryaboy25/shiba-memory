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

/**
 * Check if a resolved IP address is private/internal.
 * Covers: loopback, private ranges, link-local, cloud metadata, IPv6-mapped IPv4.
 */
function isPrivateIP(ip: string): boolean {
  // Strip IPv6-mapped IPv4 prefix (::ffff:127.0.0.1 → 127.0.0.1)
  const normalized = ip.replace(/^::ffff:/i, "");

  const blocked = [
    /^127\./,                       // loopback
    /^10\./,                        // RFC 1918
    /^172\.(1[6-9]|2\d|3[01])\./,  // RFC 1918
    /^192\.168\./,                  // RFC 1918
    /^0\./,                         // this network
    /^169\.254\./,                  // link-local / AWS metadata
    /^100\.(6[4-9]|[7-9]\d|1[0-2]\d)\./,  // CGN (RFC 6598)
    /^::1$/,                        // IPv6 loopback
    /^fe80:/i,                      // IPv6 link-local
    /^fc/i,                         // IPv6 ULA
    /^fd/i,                         // IPv6 ULA
  ];

  return blocked.some((r) => r.test(normalized));
}

async function validateUrl(url: string): Promise<void> {
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

  // Block obviously private hostnames
  const hostname = parsed.hostname.toLowerCase();
  const blockedHosts = [
    /^localhost$/,
    /^metadata\./,
    /^metadata$/,
    /^169\.254\.169\.254$/,   // AWS/GCP metadata
    /^100\.100\.100\.200$/,   // Alibaba metadata
  ];

  if (blockedHosts.some((r) => r.test(hostname))) {
    throw new Error(`Blocked host: ${hostname}. Cannot access internal/private addresses.`);
  }

  // DNS resolution check: resolve hostname and verify the IP isn't private.
  // This prevents DNS rebinding attacks where a hostname initially resolves
  // to a public IP but later resolves to a private one.
  try {
    const { resolve4, resolve6 } = await import("dns/promises");
    const ips: string[] = [];
    try { ips.push(...await resolve4(hostname)); } catch { /* no A records */ }
    try { ips.push(...await resolve6(hostname)); } catch { /* no AAAA records */ }

    for (const ip of ips) {
      if (isPrivateIP(ip)) {
        throw new Error(`Blocked host: ${hostname} resolves to private IP ${ip}.`);
      }
    }
  } catch (e) {
    if ((e as Error).message.includes("Blocked host")) throw e;
    // DNS resolution failed — allow raw IPs but check them directly
    if (isPrivateIP(hostname.replace(/^\[|\]$/g, ""))) {
      throw new Error(`Blocked host: ${hostname}. Cannot access internal/private addresses.`);
    }
  }
}

export async function ingestWeb(
  url: string,
  opts: { dryRun?: boolean; tags?: string[] } = {}
): Promise<{ stored: number; skipped: number }> {
  await validateUrl(url);

  const sourceId = await registerSource("web", url, url);

  const res = await fetch(url, {
    signal: AbortSignal.timeout(30_000), // 30s timeout — prevents slow-drip DoS
    headers: { "User-Agent": "shiba-memory/0.1 (+https://github.com/ryaboy25/shiba-memory)" },
  });
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
