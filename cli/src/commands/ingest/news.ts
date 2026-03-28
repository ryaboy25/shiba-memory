import { ingestRss } from "./rss.js";

// Preconfigured AI/tech news feeds
const NEWS_FEEDS = [
  {
    url: "https://www.anthropic.com/rss.xml",
    name: "Anthropic",
    tags: ["ai", "anthropic", "claude"],
  },
  {
    url: "https://openai.com/blog/rss.xml",
    name: "OpenAI",
    tags: ["ai", "openai", "gpt"],
  },
  {
    url: "https://blog.google/technology/ai/rss/",
    name: "Google AI",
    tags: ["ai", "google", "gemini"],
  },
  {
    url: "https://hnrss.org/best?q=AI+OR+LLM+OR+Claude+OR+GPT",
    name: "HN AI",
    tags: ["ai", "hackernews"],
  },
];

export async function ingestNews(
  opts: { dryRun?: boolean } = {}
): Promise<{
  total_stored: number;
  total_skipped: number;
  feeds: { name: string; stored: number; skipped: number; items: number }[];
}> {
  const feeds: { name: string; stored: number; skipped: number; items: number }[] = [];
  let totalStored = 0;
  let totalSkipped = 0;

  for (const feed of NEWS_FEEDS) {
    try {
      const result = await ingestRss(feed.url, {
        name: feed.name,
        dryRun: opts.dryRun,
        tags: ["news", ...feed.tags],
      });

      feeds.push({
        name: feed.name,
        stored: result.stored,
        skipped: result.skipped,
        items: result.items,
      });

      totalStored += result.stored;
      totalSkipped += result.skipped;
    } catch (err) {
      feeds.push({
        name: feed.name,
        stored: 0,
        skipped: 0,
        items: 0,
      });
    }
  }

  return {
    total_stored: totalStored,
    total_skipped: totalSkipped,
    feeds,
  };
}
