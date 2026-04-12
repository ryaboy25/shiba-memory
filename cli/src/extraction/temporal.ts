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

  // "this morning" / "this afternoon" / "this evening"
  if (/\bthis\s+morning\b/.test(lower)) {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    const end = new Date(now);
    end.setHours(12, 0, 0, 0);
    return { after: start, before: end };
  }
  if (/\bthis\s+(?:afternoon|evening)\b/.test(lower)) {
    const start = new Date(now);
    start.setHours(12, 0, 0, 0);
    return { after: start, before: now };
  }

  // "last N hours"
  const hoursMatch = lower.match(/\b(?:last|past)\s+(\d+)\s+hours?\b/);
  if (hoursMatch) {
    const start = new Date(now);
    start.setHours(start.getHours() - parseInt(hoursMatch[1]));
    return { after: start, before: now };
  }

  // "before last week" / "before yesterday"
  if (/\bbefore\s+yesterday\b/.test(lower)) {
    const end = new Date(now);
    end.setDate(end.getDate() - 1);
    end.setHours(0, 0, 0, 0);
    const start = new Date(end);
    start.setMonth(start.getMonth() - 3);
    return { after: start, before: end };
  }

  // "since Monday" / "since Tuesday" etc.
  const dayNames = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  const sinceDay = lower.match(new RegExp(`\\bsince\\s+(${dayNames.join("|")})\\b`));
  if (sinceDay) {
    const targetDay = dayNames.indexOf(sinceDay[1]);
    const start = new Date(now);
    const diff = (now.getDay() - targetDay + 7) % 7 || 7;
    start.setDate(start.getDate() - diff);
    start.setHours(0, 0, 0, 0);
    return { after: start, before: now };
  }

  // "on Monday" / "on Tuesday" etc. (most recent occurrence)
  const onDay = lower.match(new RegExp(`\\bon\\s+(${dayNames.join("|")})\\b`));
  if (onDay) {
    const targetDay = dayNames.indexOf(onDay[1]);
    const start = new Date(now);
    const diff = (now.getDay() - targetDay + 7) % 7 || 7;
    start.setDate(start.getDate() - diff);
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setHours(23, 59, 59, 999);
    return { after: start, before: end };
  }

  // "earlier" / "previously" / "before" (broad: last 30 days)
  if (/\b(?:earlier|previously)\b/.test(lower)) {
    const start = new Date(now);
    start.setDate(start.getDate() - 30);
    return { after: start, before: now };
  }

  return null;
}
