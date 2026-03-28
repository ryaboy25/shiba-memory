import { registerSource, ingestChunk, updateLastIngested } from "./common.js";

interface RssItem {
  title: string;
  link: string;
  description: string;
  pubDate: string;
}

function parseRss(xml: string): RssItem[] {
  const items: RssItem[] = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
  let match;

  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];
    const title = block.match(/<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i)?.[1]?.trim() || "";
    const link = block.match(/<link[^>]*>([\s\S]*?)<\/link>/i)?.[1]?.trim() || "";
    const desc = block.match(/<description[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/i)?.[1]?.trim() || "";
    const pubDate = block.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i)?.[1]?.trim() || "";

    if (title) {
      items.push({
        title: title.replace(/<[^>]+>/g, ""),
        link,
        description: desc.replace(/<[^>]+>/g, "").slice(0, 1000),
        pubDate,
      });
    }
  }

  // Also handle Atom feeds
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/gi;
  while ((match = entryRegex.exec(xml)) !== null) {
    const block = match[1];
    const title = block.match(/<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i)?.[1]?.trim() || "";
    const link = block.match(/<link[^>]*href="([^"]+)"/i)?.[1] || "";
    const desc = block.match(/<(?:summary|content)[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/(?:summary|content)>/i)?.[1]?.trim() || "";
    const pubDate = block.match(/<(?:published|updated)[^>]*>([\s\S]*?)<\/(?:published|updated)>/i)?.[1]?.trim() || "";

    if (title) {
      items.push({
        title: title.replace(/<[^>]+>/g, ""),
        link,
        description: desc.replace(/<[^>]+>/g, "").slice(0, 1000),
        pubDate,
      });
    }
  }

  return items;
}

export async function ingestRss(
  feedUrl: string,
  opts: { name?: string; dryRun?: boolean; tags?: string[] } = {}
): Promise<{ stored: number; skipped: number; items: number }> {
  const name = opts.name || new URL(feedUrl).hostname;
  const sourceId = await registerSource("rss", name, feedUrl);

  const res = await fetch(feedUrl);
  if (!res.ok) throw new Error(`Failed to fetch RSS ${feedUrl}: ${res.status}`);

  const xml = await res.text();
  const items = parseRss(xml);

  let stored = 0;
  let skipped = 0;

  for (const item of items) {
    const content = `${item.description}\n\nSource: ${item.link}\nPublished: ${item.pubDate}`;

    const result = await ingestChunk(item.title, content, {
      type: "reference",
      tags: ["rss", name, ...(opts.tags || [])],
      source: "ingest",
      importance: 0.3,
      dryRun: opts.dryRun,
      expiresIn: "90d",
    }, sourceId);

    if (result.skipped) skipped++;
    else stored++;
  }

  if (!opts.dryRun) {
    await updateLastIngested(sourceId);
  }

  return { stored, skipped, items: items.length };
}
