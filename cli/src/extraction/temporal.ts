/**
 * Temporal Query Parser
 * ======================
 * Parses natural language time references from recall queries.
 * Returns date ranges that the temporal retrieval channel uses.
 * No LLM needed — pure regex.
 */

export interface TemporalRange {
  after: Date;
  before: Date;
}

/**
 * Parse temporal references from a query string.
 * Returns null if no temporal reference found.
 */
export function parseTemporalQuery(query: string): TemporalRange | null {
  const lower = query.toLowerCase();
  const now = new Date();

  // "today"
  if (/\btoday\b/.test(lower)) {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    return { after: start, before: now };
  }

  // "yesterday"
  if (/\byesterday\b/.test(lower)) {
    const start = new Date(now);
    start.setDate(start.getDate() - 1);
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setHours(23, 59, 59, 999);
    return { after: start, before: end };
  }

  // "last week" / "this week" / "past week"
  if (/\b(?:last|this|past)\s+week\b/.test(lower)) {
    const start = new Date(now);
    start.setDate(start.getDate() - 7);
    return { after: start, before: now };
  }

  // "last month" / "this month" / "past month"
  if (/\b(?:last|this|past)\s+month\b/.test(lower)) {
    const start = new Date(now);
    start.setMonth(start.getMonth() - 1);
    return { after: start, before: now };
  }

  // "last year" / "this year" / "past year"
  if (/\b(?:last|this|past)\s+year\b/.test(lower)) {
    const start = new Date(now);
    start.setFullYear(start.getFullYear() - 1);
    return { after: start, before: now };
  }

  // "N days ago" / "N weeks ago" / "N months ago"
  const agoMatch = lower.match(/(\d+)\s+(day|week|month|year)s?\s+ago/);
  if (agoMatch) {
    const n = parseInt(agoMatch[1]);
    const unit = agoMatch[2];
    const start = new Date(now);
    const end = new Date(now);

    switch (unit) {
      case "day":
        start.setDate(start.getDate() - n - 1);
        end.setDate(end.getDate() - n + 1);
        break;
      case "week":
        start.setDate(start.getDate() - n * 7 - 3);
        end.setDate(end.getDate() - n * 7 + 3);
        break;
      case "month":
        start.setMonth(start.getMonth() - n - 1);
        end.setMonth(end.getMonth() - n + 1);
        break;
      case "year":
        start.setFullYear(start.getFullYear() - n - 1);
        end.setFullYear(end.getFullYear() - n + 1);
        break;
    }
    return { after: start, before: end };
  }

  // "in January" / "in March" / etc.
  const monthNames = ["january", "february", "march", "april", "may", "june",
    "july", "august", "september", "october", "november", "december"];
  const monthMatch = lower.match(new RegExp(`\\bin\\s+(${monthNames.join("|")})\\b`));
  if (monthMatch) {
    const monthIdx = monthNames.indexOf(monthMatch[1]);
    const year = monthIdx > now.getMonth() ? now.getFullYear() - 1 : now.getFullYear();
    const start = new Date(year, monthIdx, 1);
    const end = new Date(year, monthIdx + 1, 0, 23, 59, 59);
    return { after: start, before: end };
  }

  // "recently" / "recent"
  if (/\brecent(?:ly)?\b/.test(lower)) {
    const start = new Date(now);
    start.setDate(start.getDate() - 14);
    return { after: start, before: now };
  }

  // "last few days"
  if (/\blast\s+(?:few|couple)\s+days\b/.test(lower)) {
    const start = new Date(now);
    start.setDate(start.getDate() - 3);
    return { after: start, before: now };
  }

  return null;
}
