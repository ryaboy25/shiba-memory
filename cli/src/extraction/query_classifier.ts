/**
 * Query-Aware Retrieval Policy
 * =============================
 * Classifies recall queries by type and adjusts search strategy dynamically.
 * Inspired by Brainstack's "control plane" — different queries need different
 * retrieval depths and scoring weights.
 *
 * No LLM needed — pure regex heuristics.
 */

export interface QueryPolicy {
  category: "preference" | "factual" | "temporal" | "high_stakes" | "exploratory" | "entity";
  depth: number;        // how many results to fetch (5-30)
  rerank: boolean;      // whether to apply cross-encoder reranking
  recencyWeight: number; // how much to boost recent memories (0-0.5)
}

/**
 * Classify a query and return a retrieval policy.
 * The policy adjusts search behavior per query type.
 */
export function classifyQuery(query: string): QueryPolicy {
  const lower = query.toLowerCase();

  // High-stakes: medical, legal, safety, financial decisions
  if (/\b(surgery|medical|doctor|hospital|medication|drug|dosage|allergy|legal|lawyer|attorney|lawsuit|safety|emergency|critical|urgent|financial|investment|tax)\b/.test(lower)) {
    return {
      category: "high_stakes",
      depth: 20,
      rerank: true,
      recencyWeight: 0.1,
    };
  }

  // Temporal: time-based queries
  if (/\b(yesterday|today|last\s+week|last\s+month|recently|when\s+did|how\s+long|ago|before|after|since|during)\b/.test(lower)) {
    return {
      category: "temporal",
      depth: 15,
      rerank: false,
      recencyWeight: 0.4,
    };
  }

  // Preference: what the user likes/prefers
  if (/\b(prefer|like|favorite|style|usually|always|habit|convention|standard)\b/.test(lower)) {
    return {
      category: "preference",
      depth: 5,
      rerank: false,
      recencyWeight: 0.2,
    };
  }

  // Entity-focused: asking about a specific person/pet/place
  if (/\b(who\s+is|where\s+is|what\s+is\s+\w+'s|my\s+(?:dog|cat|wife|husband|boss|friend|mom|dad|brother|sister))\b/.test(lower)) {
    return {
      category: "entity",
      depth: 15,
      rerank: false,
      recencyWeight: 0.1,
    };
  }

  // Exploratory: why, how, explain
  if (/\b(why|how|explain|what\s+happened|tell\s+me\s+about|describe|summarize)\b/.test(lower)) {
    return {
      category: "exploratory",
      depth: 15,
      rerank: true,
      recencyWeight: 0.1,
    };
  }

  // Default: factual query
  return {
    category: "factual",
    depth: 10,
    rerank: false,
    recencyWeight: 0.1,
  };
}
