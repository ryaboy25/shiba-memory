/**
 * Tier 2: Targeted LLM Extraction
 * ================================
 * Small, focused LLM calls on specific trigger moments.
 * ~200-500 tokens per extraction. 3-5 extractions per session max.
 *
 * Only runs when SHB_LLM_PROVIDER != "none".
 */

import { llmChat, isLLMAvailable, type ChatMessage } from "../llm.js";

export interface ExtractionResult {
  facts: {
    type: "user" | "feedback" | "project" | "skill" | "instinct" | "episode";
    title: string;
    content: string;
    confidence: number;
    tags: string[];
  }[];
  tokens_used: number;
}

const EMPTY: ExtractionResult = { facts: [], tokens_used: 0 };

/**
 * Extract what was corrected when a user corrects the AI.
 * ~300 tokens.
 */
export async function extractCorrection(
  userMessage: string,
  previousAiOutput: string,
): Promise<ExtractionResult> {
  if (!isLLMAvailable()) return EMPTY;

  const messages: ChatMessage[] = [
    {
      role: "system",
      content: `You extract corrections from conversations. Given a user's correction and the AI's previous output, identify what was wrong and what the correct answer/approach is. Reply as JSON: {"wrong": "what was wrong", "correct": "what is correct", "rule": "general rule to remember"}`,
    },
    {
      role: "user",
      content: `AI said: "${previousAiOutput.slice(0, 300)}"\n\nUser corrected: "${userMessage.slice(0, 300)}"`,
    },
  ];

  const response = await llmChat(messages, 200);
  if (!response) return EMPTY;

  try {
    // Try to parse JSON from the response
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      // If no JSON, store the raw correction
      return {
        facts: [{
          type: "feedback",
          title: `Correction: ${userMessage.slice(0, 60)}`,
          content: `User corrected: "${userMessage.slice(0, 300)}". Previous AI output: "${previousAiOutput.slice(0, 200)}"`,
          confidence: 0.7,
          tags: ["correction", "tier-2-targeted"],
        }],
        tokens_used: 300,
      };
    }

    const parsed = JSON.parse(jsonMatch[0]) as { wrong?: string; correct?: string; rule?: string };
    const facts: ExtractionResult["facts"] = [];

    if (parsed.rule) {
      facts.push({
        type: "feedback",
        title: `Rule: ${parsed.rule.slice(0, 80)}`,
        content: `Wrong: ${parsed.wrong || "unknown"}. Correct: ${parsed.correct || "unknown"}. Rule: ${parsed.rule}`,
        confidence: 0.8,
        tags: ["correction", "rule", "tier-2-targeted"],
      });
    } else if (parsed.correct) {
      facts.push({
        type: "feedback",
        title: `Correction: ${parsed.correct.slice(0, 80)}`,
        content: `Wrong: ${parsed.wrong || "unknown"}. Correct: ${parsed.correct}`,
        confidence: 0.7,
        tags: ["correction", "tier-2-targeted"],
      });
    }

    return { facts, tokens_used: 300 };
  } catch {
    return {
      facts: [{
        type: "feedback",
        title: `Correction: ${userMessage.slice(0, 60)}`,
        content: response.slice(0, 500),
        confidence: 0.6,
        tags: ["correction", "tier-2-targeted"],
      }],
      tokens_used: 300,
    };
  }
}

/**
 * Extract a decision from a conversation snippet.
 * ~400 tokens.
 */
export async function extractDecision(
  conversationSnippet: string,
): Promise<ExtractionResult> {
  if (!isLLMAvailable()) return EMPTY;

  const messages: ChatMessage[] = [
    {
      role: "system",
      content: `Extract the key decision from this conversation. Reply as JSON: {"decision": "what was decided", "reason": "why", "scope": "project or general"}`,
    },
    {
      role: "user",
      content: conversationSnippet.slice(0, 500),
    },
  ];

  const response = await llmChat(messages, 200);
  if (!response) return EMPTY;

  try {
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return {
        facts: [{
          type: "project",
          title: `Decision: ${conversationSnippet.slice(0, 60)}`,
          content: response.slice(0, 500),
          confidence: 0.7,
          tags: ["decision", "tier-2-targeted"],
        }],
        tokens_used: 400,
      };
    }

    const parsed = JSON.parse(jsonMatch[0]) as { decision?: string; reason?: string; scope?: string };

    return {
      facts: [{
        type: parsed.scope === "general" ? "skill" : "project",
        title: `Decision: ${(parsed.decision || conversationSnippet).slice(0, 80)}`,
        content: `Decision: ${parsed.decision || "unknown"}. Reason: ${parsed.reason || "unknown"}.`,
        confidence: 0.7,
        tags: ["decision", "tier-2-targeted"],
      }],
      tokens_used: 400,
    };
  } catch {
    return EMPTY;
  }
}

/**
 * Extract implicit preferences from a conversation.
 * Looks for behavioral signals: what did the user accept, reject, edit, or repeatedly do?
 * ~400 tokens. Run at session end for biggest ROI on preference detection.
 */
export async function extractPreferences(
  messages: { role: string; content: string }[],
): Promise<ExtractionResult> {
  if (!isLLMAvailable()) return EMPTY;

  // Build a compact transcript focusing on user actions
  const transcript = messages.slice(-30)
    .map((m) => `${m.role}: ${m.content.slice(0, 150)}`)
    .join("\n");

  const chatMessages: ChatMessage[] = [
    {
      role: "system",
      content: `Analyze this conversation and extract implicit user preferences — things the user didn't explicitly say "I prefer X" but revealed through behavior. Look for:
- What the user accepted vs rejected/edited
- Patterns in how they want things done (code style, communication style, tool choices)
- Repeated corrections that imply a preference
- Technical choices that reveal opinions

Reply as JSON: {"preferences": [{"preference": "...", "evidence": "...", "confidence": 0.0-1.0}]}
Return an empty array if no clear preferences are detected. Max 5 preferences.`,
    },
    {
      role: "user",
      content: transcript.slice(0, 2000),
    },
  ];

  const response = await llmChat(chatMessages, 400);
  if (!response) return EMPTY;

  try {
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return EMPTY;

    const parsed = JSON.parse(jsonMatch[0]) as {
      preferences?: { preference?: string; evidence?: string; confidence?: number }[];
    };

    if (!parsed.preferences?.length) return EMPTY;

    const facts: ExtractionResult["facts"] = parsed.preferences
      .filter((p) => p.preference && (p.confidence || 0.5) >= 0.4)
      .map((p) => ({
        type: "instinct" as const,
        title: `Preference: ${(p.preference || "").slice(0, 80)}`,
        content: `Implicit preference: ${p.preference}. Evidence: ${p.evidence || "behavioral observation"}.`,
        confidence: Math.min(p.confidence || 0.5, 0.6), // Cap at 0.6 — instincts need confirmation
        tags: ["preference", "implicit", "tier-2-targeted"],
      }));

    return { facts, tokens_used: 400 };
  } catch {
    return EMPTY;
  }
}

/**
 * Summarize a session's key points.
 * ~500 tokens.
 */
export async function summarizeSession(
  messages: { role: string; content: string }[],
  projectName?: string,
): Promise<ExtractionResult> {
  if (!isLLMAvailable()) return EMPTY;

  // Take last N messages to fit in context
  const recent = messages.slice(-20);
  const transcript = recent
    .map((m) => `${m.role}: ${m.content.slice(0, 150)}`)
    .join("\n");

  const chatMessages: ChatMessage[] = [
    {
      role: "system",
      content: `Summarize this coding session in 2-3 sentences. Focus on: what was worked on, key decisions made, and any user preferences expressed. Reply as JSON: {"summary": "...", "topics": ["..."], "decisions": ["..."]}`,
    },
    {
      role: "user",
      content: `${projectName ? `Project: ${projectName}\n` : ""}Session transcript:\n${transcript.slice(0, 1500)}`,
    },
  ];

  const response = await llmChat(chatMessages, 300);
  if (!response) return EMPTY;

  try {
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    const parsed = jsonMatch
      ? JSON.parse(jsonMatch[0]) as { summary?: string; topics?: string[]; decisions?: string[] }
      : { summary: response };

    const facts: ExtractionResult["facts"] = [];

    if (parsed.summary) {
      facts.push({
        type: "episode",
        title: `Session summary${projectName ? ` — ${projectName}` : ""}`,
        content: parsed.summary,
        confidence: 0.6,
        tags: ["session-summary", "tier-2-targeted", ...(parsed.topics || [])],
      });
    }

    if (parsed.decisions) {
      for (const d of parsed.decisions) {
        facts.push({
          type: "project",
          title: `Decision: ${d.slice(0, 80)}`,
          content: d,
          confidence: 0.7,
          tags: ["decision", "session-extracted", "tier-2-targeted"],
        });
      }
    }

    return { facts, tokens_used: 500 };
  } catch {
    return {
      facts: [{
        type: "episode",
        title: `Session summary${projectName ? ` — ${projectName}` : ""}`,
        content: response.slice(0, 500),
        confidence: 0.5,
        tags: ["session-summary", "tier-2-targeted"],
      }],
      tokens_used: 500,
    };
  }
}

/**
 * Determine if a new fact contradicts an existing memory (NLI).
 * ~300 tokens.
 */
export async function checkContradiction(
  newFact: string,
  existingMemory: string,
): Promise<{ contradicts: boolean; explanation: string }> {
  if (!isLLMAvailable()) return { contradicts: false, explanation: "" };

  const messages: ChatMessage[] = [
    {
      role: "system",
      content: `Determine if two facts contradict each other. Reply as JSON: {"contradicts": true/false, "explanation": "why"}`,
    },
    {
      role: "user",
      content: `Fact A: "${existingMemory.slice(0, 300)}"\nFact B: "${newFact.slice(0, 300)}"`,
    },
  ];

  const response = await llmChat(messages, 150);
  if (!response) return { contradicts: false, explanation: "" };

  try {
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]) as { contradicts?: boolean; explanation?: string };
      return {
        contradicts: !!parsed.contradicts,
        explanation: parsed.explanation || "",
      };
    }
  } catch { /* fall through */ }

  return {
    contradicts: response.toLowerCase().includes("contradict"),
    explanation: response.slice(0, 200),
  };
}
