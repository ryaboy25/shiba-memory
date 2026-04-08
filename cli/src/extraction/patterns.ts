/**
 * Tier 1: Pattern-Based Fact Extraction
 * ======================================
 * Zero tokens. Pure regex + heuristics.
 * Detects preferences, corrections, decisions, and explicit memory requests.
 * Covers ~70% of useful memory capture.
 */

export interface ExtractedFact {
  type: "user" | "feedback" | "project" | "skill" | "instinct";
  title: string;
  content: string;
  confidence: number;
  tags: string[];
}

interface PatternRule {
  pattern: RegExp;
  type: ExtractedFact["type"];
  titlePrefix: string;
  confidence: number;
  tags: string[];
}

const PREFERENCE_PATTERNS: PatternRule[] = [
  // Explicit preferences
  { pattern: /\bi (?:always |usually )?prefer\b(.{5,100})/i, type: "user", titlePrefix: "Preference", confidence: 0.7, tags: ["preference"] },
  { pattern: /\bi (?:always |usually )?like (?:to |using |when )\b(.{5,100})/i, type: "user", titlePrefix: "Preference", confidence: 0.6, tags: ["preference"] },
  { pattern: /\bi (?:always |usually )?use\b(.{5,100})/i, type: "user", titlePrefix: "Preference", confidence: 0.5, tags: ["preference"] },

  // Corrections / negative feedback
  { pattern: /\bdon'?t\b(.{5,80})/i, type: "feedback", titlePrefix: "Correction", confidence: 0.7, tags: ["correction"] },
  { pattern: /\bstop\b(.{5,80})/i, type: "feedback", titlePrefix: "Correction", confidence: 0.7, tags: ["correction"] },
  { pattern: /\bnever\b(.{5,80})/i, type: "feedback", titlePrefix: "Correction", confidence: 0.7, tags: ["correction"] },
  { pattern: /\bavoid\b(.{5,80})/i, type: "feedback", titlePrefix: "Correction", confidence: 0.6, tags: ["correction"] },
  { pattern: /\bthat'?s (?:wrong|incorrect|not right)\b(.{0,80})/i, type: "feedback", titlePrefix: "Correction", confidence: 0.8, tags: ["correction"] },
  { pattern: /\bactually[,]?\s+(.{5,100})/i, type: "feedback", titlePrefix: "Correction", confidence: 0.6, tags: ["correction"] },

  // Explicit memory requests
  { pattern: /\bremember (?:that |this: ?)?(.{5,200})/i, type: "user", titlePrefix: "Remember", confidence: 0.8, tags: ["explicit"] },
  { pattern: /\bnote (?:that |this: ?)?(.{5,200})/i, type: "project", titlePrefix: "Note", confidence: 0.7, tags: ["explicit"] },
  { pattern: /\bkeep in mind (?:that )?(.{5,200})/i, type: "user", titlePrefix: "Note", confidence: 0.7, tags: ["explicit"] },

  // Identity / biographical
  { pattern: /\bi (?:am|work as|'m) (?:a |an )?(.{3,80})/i, type: "user", titlePrefix: "Identity", confidence: 0.7, tags: ["identity"] },
  { pattern: /\bmy (?:name|role|title|job) is\b(.{3,60})/i, type: "user", titlePrefix: "Identity", confidence: 0.8, tags: ["identity"] },
  { pattern: /\bi work (?:at|for|with)\b(.{3,60})/i, type: "user", titlePrefix: "Identity", confidence: 0.7, tags: ["identity"] },

  // Technical preferences
  { pattern: /\balways use\b(.{5,80})/i, type: "skill", titlePrefix: "Practice", confidence: 0.6, tags: ["practice"] },
  { pattern: /\bour (?:convention|standard|pattern) is\b(.{5,100})/i, type: "skill", titlePrefix: "Convention", confidence: 0.7, tags: ["convention"] },
  { pattern: /\bwe (?:always|usually|typically)\b(.{5,100})/i, type: "skill", titlePrefix: "Convention", confidence: 0.5, tags: ["convention"] },

  // Decisions
  { pattern: /\blet'?s (?:go with|use|do|stick with)\b(.{5,80})/i, type: "project", titlePrefix: "Decision", confidence: 0.7, tags: ["decision"] },
  { pattern: /\bdecided (?:to |on )\b(.{5,100})/i, type: "project", titlePrefix: "Decision", confidence: 0.8, tags: ["decision"] },
];

/**
 * Extract facts from a user message using pattern matching.
 * Returns zero or more facts. No LLM calls — pure regex.
 */
export function extractPatterns(message: string, role: "user" | "assistant" = "user"): ExtractedFact[] {
  // Only extract from user messages (assistant messages are AI-generated, not facts)
  if (role !== "user") return [];

  // Skip very short messages
  if (message.length < 10) return [];

  const facts: ExtractedFact[] = [];
  const seen = new Set<string>();

  for (const rule of PREFERENCE_PATTERNS) {
    const match = message.match(rule.pattern);
    if (!match || !match[1]) continue;

    const captured = match[1].trim().replace(/[.!?,;]+$/, "").trim();
    if (captured.length < 5) continue;

    // Deduplicate by content
    const key = `${rule.type}:${captured.toLowerCase().slice(0, 50)}`;
    if (seen.has(key)) continue;
    seen.add(key);

    facts.push({
      type: rule.type,
      title: `${rule.titlePrefix}: ${captured.slice(0, 80)}`,
      content: `User stated: "${message.slice(0, 300)}".\nExtracted: ${captured}`,
      confidence: rule.confidence,
      tags: [...rule.tags, "tier-1-pattern"],
    });
  }

  return facts;
}

/**
 * Detect if a user message is a correction of the AI's previous output.
 * Returns true if the message looks like a correction.
 */
export function isCorrection(userMessage: string): boolean {
  const correctionSignals = [
    /^no[,.]?\s/i,
    /^wrong/i,
    /^that'?s (?:not|wrong|incorrect)/i,
    /^actually[,]?\s/i,
    /^not (?:quite|exactly|right)/i,
    /\binstead[,]?\s/i,
    /\bshould (?:be|have been)\b/i,
    /^fix /i,
    /^change /i,
  ];
  return correctionSignals.some((r) => r.test(userMessage.trim()));
}

/**
 * Detect if a message contains a decision.
 */
export function isDecision(userMessage: string): boolean {
  const decisionSignals = [
    /\blet'?s (?:go with|use|do)\b/i,
    /\bdecided\b/i,
    /\bwe'?(?:ll| will) (?:use|go with|do)\b/i,
    /\bthe plan is\b/i,
    /\bapproved\b/i,
  ];
  return decisionSignals.some((r) => r.test(userMessage.trim()));
}
