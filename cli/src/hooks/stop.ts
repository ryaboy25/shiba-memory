#!/usr/bin/env node

import { runHook, getProject } from "./common.js";
import { query } from "../db.js";

runHook(async (input) => {
  const sessionId = input.session_id || "unknown";
  const project = getProject(input);

  // Upsert conversation record
  await query(
    `INSERT INTO conversations (session_id, ended_at, metadata)
     VALUES ($1, now(), $2)
     ON CONFLICT (session_id) DO UPDATE
     SET ended_at = now(),
         metadata = conversations.metadata || $2`,
    [
      sessionId,
      JSON.stringify({ project: project.name, project_path: project.path }),
    ]
  );
});
