import { query } from "../db.js";
import { remember } from "./remember.js";

function todayDate(): string {
  return new Date().toISOString().split("T")[0]; // YYYY-MM-DD
}

export async function appendLog(
  note: string,
  date?: string
): Promise<string> {
  const logDate = date || todayDate();
  const tag = `daily-log-${logDate}`;
  const timestamp = new Date().toLocaleTimeString("en-US", { hour12: false });

  // Check if today's log exists
  const existing = await query<{ id: string; content: string }>(
    `SELECT id, content FROM memories
     WHERE type = 'episode' AND tags @> ARRAY[$1]
     LIMIT 1`,
    [tag]
  );

  const entry = `[${timestamp}] ${note}`;

  if (existing.rows.length > 0) {
    // Append to existing log
    const newContent = existing.rows[0].content + "\n" + entry;
    await query(
      `UPDATE memories SET content = $1 WHERE id = $2::uuid`,
      [newContent, existing.rows[0].id]
    );
    return existing.rows[0].id;
  } else {
    // Create new daily log via remember() for consistent handling
    return remember({
      type: "episode",
      title: `Daily Log: ${logDate}`,
      content: entry,
      tags: ["daily-log", tag],
      importance: 0.4,
      source: "log",
    });
  }
}

export async function showLog(
  date?: string
): Promise<{ date: string; content: string } | null> {
  const logDate = date || todayDate();
  const tag = `daily-log-${logDate}`;

  const result = await query<{ content: string }>(
    `SELECT content FROM memories
     WHERE type = 'episode' AND tags @> ARRAY[$1]
     LIMIT 1`,
    [tag]
  );

  if (result.rows.length === 0) return null;
  return { date: logDate, content: result.rows[0].content };
}

export async function recentLogs(
  days: number = 3
): Promise<{ date: string; content: string }[]> {
  const result = await query<{ title: string; content: string }>(
    `SELECT title, content FROM memories
     WHERE type = 'episode' AND tags @> ARRAY['daily-log']
     ORDER BY created_at DESC
     LIMIT $1::int`,
    [days]
  );

  return result.rows.map((r) => ({
    date: r.title.replace("Daily Log: ", ""),
    content: r.content,
  }));
}
