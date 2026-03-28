#!/usr/bin/env node

import { runHook, getProject, formatMemoriesAsMarkdown } from "./common.js";
import { recall } from "../commands/recall.js";
import { query } from "../db.js";

runHook(async (input) => {
  const project = getProject(input);
  const sections: string[] = [];

  // 1. Load pending events from the gateway queue
  const events = await query<{
    id: number;
    source: string;
    event_type: string;
    payload: Record<string, unknown>;
    created_at: string;
  }>(
    `SELECT id, source, event_type, payload, created_at
     FROM events_queue WHERE NOT processed
     ORDER BY created_at ASC LIMIT 10`
  );

  if (events.rows.length > 0) {
    const eventLines = ["## CCB -- Pending Events", ""];
    for (const e of events.rows) {
      const msg = (e.payload.message as string) || JSON.stringify(e.payload);
      eventLines.push(`- **[${e.event_type}]** ${msg} *(${e.source}, ${new Date(e.created_at).toLocaleString()})*`);
    }
    eventLines.push("");
    sections.push(eventLines.join("\n"));

    // Mark as processed
    const ids = events.rows.map((e) => e.id);
    await query(
      `UPDATE events_queue SET processed = true, processed_at = now()
       WHERE id = ANY($1::bigint[])`,
      [ids]
    );
  }

  // 2. Load today's daily log for continuity
  const today = new Date().toISOString().split("T")[0];
  const todayTag = `daily-log-${today}`;
  const log = await query<{ content: string }>(
    `SELECT content FROM memories
     WHERE type = 'episode' AND tags @> ARRAY[$1]
     LIMIT 1`,
    [todayTag]
  );

  if (log.rows.length > 0) {
    sections.push(`## CCB -- Today's Log (${today})\n\n${log.rows[0].content}\n`);
  }

  // 3. Load active progress trackers
  const trackers = await query<{ title: string; content: string }>(
    `SELECT title, content FROM memories
     WHERE type = 'project' AND metadata->>'tracker' IS NOT NULL
     ORDER BY updated_at DESC LIMIT 3`
  );

  if (trackers.rows.length > 0) {
    const trackLines = ["## CCB -- Active Trackers", ""];
    for (const t of trackers.rows) {
      trackLines.push(`**${t.title}**: ${t.content}`);
    }
    trackLines.push("");
    sections.push(trackLines.join("\n"));
  }

  // 4. Recall project-relevant memories (skipTouch for speed)
  const projectMemories = await recall({
    query: project.name,
    project: project.path,
    limit: 8,
    skipTouch: true,
  });

  // 5. Recall user profile memories
  const userMemories = await recall({
    query: "user preferences role expertise",
    type: "user",
    limit: 3,
    skipTouch: true,
  });

  // Merge and deduplicate by ID
  const seen = new Set<string>();
  const all = [...userMemories, ...projectMemories].filter((m) => {
    if (seen.has(m.id)) return false;
    seen.add(m.id);
    return true;
  });

  if (all.length > 0) {
    sections.push(formatMemoriesAsMarkdown(all));
  }

  if (sections.length === 0) return;

  return sections.join("\n");
});
