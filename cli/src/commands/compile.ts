/**
 * Knowledge Compilation
 * ======================
 * Synthesizes episodic memories into structured knowledge articles.
 * Like claude-memory-compiler's approach: raw observations → curated articles.
 *
 * Usage: shiba compile [--project path]
 *
 * Takes recent episodes and extracted facts, groups them by topic,
 * and generates a concise knowledge article per topic.
 */

import { query } from "../db.js";
import { remember } from "./remember.js";
import { llmChat, isLLMAvailable } from "../llm.js";

export interface CompileResult {
  articles_created: number;
  episodes_processed: number;
  tokens_used: number;
}

export async function compile(projectPath?: string): Promise<CompileResult> {
  const result: CompileResult = { articles_created: 0, episodes_processed: 0, tokens_used: 0 };

  if (!isLLMAvailable()) {
    return result; // Need LLM for compilation
  }

  // Get recent episodes grouped by session/conversation
  const sessions = await query<{
    session_tag: string;
    episode_count: number;
    content_sample: string;
  }>(
    `SELECT
       (SELECT unnest(tags) FROM (SELECT tags FROM memories WHERE id = m.id) sub
        WHERE unnest LIKE 'session-%' LIMIT 1) AS session_tag,
       COUNT(*) AS episode_count,
       string_agg(LEFT(content, 200), ' | ' ORDER BY created_at) AS content_sample
     FROM memories m
     WHERE type = 'episode'
       AND source = 'import'
       AND created_at > now() - interval '30 days'
       ${projectPath ? "AND project_path = $1" : ""}
     GROUP BY 1
     HAVING COUNT(*) >= 3
     ORDER BY MAX(created_at) DESC
     LIMIT 20`,
    projectPath ? [projectPath] : []
  );

  for (const session of sessions.rows) {
    if (!session.session_tag || !session.content_sample) continue;

    // Ask LLM to synthesize into a knowledge article
    const response = await llmChat([
      {
        role: "system",
        content: `Synthesize these conversation excerpts into a concise knowledge article (3-5 sentences). Focus on key facts, decisions, and learnings. Return JSON: {"title": "...", "article": "...", "topics": ["..."]}`,
      },
      {
        role: "user",
        content: session.content_sample.slice(0, 1500),
      },
    ], 400);

    result.tokens_used += 400;
    result.episodes_processed += Number(session.episode_count);

    if (!response) continue;

    try {
      const cleaned = response.replace(/```(?:json)?\s*\n?/gi, "").trim();
      let jsonStr = cleaned;
      try { JSON.parse(jsonStr); } catch {
        if (jsonStr.includes('"title"')) jsonStr = jsonStr.replace(/,?\s*$/, "") + "}";
      }

      const parsed = JSON.parse(jsonStr) as { title?: string; article?: string; topics?: string[] };
      if (parsed.title && parsed.article) {
        await remember({
          type: "skill",
          title: `Knowledge: ${parsed.title.slice(0, 80)}`,
          content: parsed.article,
          tags: ["compiled", "knowledge-article", ...(parsed.topics || [])],
          importance: 0.7,
          source: "compilation",
          projectPath,
        });
        result.articles_created++;
      }
    } catch { /* parse failed */ }
  }

  return result;
}
