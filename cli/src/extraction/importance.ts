/**
 * LLM-based importance estimation.
 * Scores how important a memory is (0.0-1.0) based on content.
 * Only runs when SHB_LLM_PROVIDER != "none".
 */

import { llmChat, isLLMAvailable } from "../llm.js";

/**
 * Estimate importance of a memory. Returns 0.1-1.0.
 * Falls back to heuristic if LLM unavailable.
 */
export async function estimateImportance(
  type: string,
  title: string,
  content: string,
): Promise<number> {
  // Heuristic baseline (always available, no tokens)
  const heuristic = heuristicImportance(type, title, content);

  if (!isLLMAvailable()) return heuristic;

  try {
    const response = await llmChat([
      {
        role: "system",
        content: `Rate the importance of this memory on a scale of 0.1 to 1.0. Consider: how likely is this to be useful in future conversations? Reply with ONLY a number like 0.7`,
      },
      {
        role: "user",
        content: `Type: ${type}\nTitle: ${title}\nContent: ${content.slice(0, 300)}`,
      },
    ], 20);

    const match = response.match(/\d\.\d/);
    if (match) {
      const score = parseFloat(match[0]);
      if (score >= 0.1 && score <= 1.0) return score;
    }
  } catch {
    // LLM failed, use heuristic
  }

  return heuristic;
}

function heuristicImportance(type: string, title: string, content: string): number {
  // Base by type
  const typeScores: Record<string, number> = {
    user: 0.8,
    feedback: 0.8,
    skill: 0.7,
    project: 0.6,
    reference: 0.5,
    instinct: 0.4,
    episode: 0.3,
  };

  let score = typeScores[type] || 0.5;

  // Boost for explicit statements
  const lower = content.toLowerCase();
  if (lower.includes("always") || lower.includes("never") || lower.includes("important")) score += 0.1;
  if (lower.includes("prefer") || lower.includes("don't")) score += 0.05;
  if (title.toLowerCase().includes("decision")) score += 0.1;

  // Longer content = slightly more important
  if (content.length > 200) score += 0.05;

  return Math.min(Math.max(score, 0.1), 1.0);
}
