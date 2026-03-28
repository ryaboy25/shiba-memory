import { query } from "../db.js";
import { embed, pgVector } from "../embeddings.js";

interface TrackerFeature {
  name: string;
  status: "todo" | "in_progress" | "done" | "blocked";
  notes?: string;
  updated_at: string;
}

interface Tracker {
  project: string;
  features: TrackerFeature[];
  created_at: string;
  updated_at: string;
}

export async function createTracker(
  projectName: string,
  features: string[] = []
): Promise<string> {
  const tracker: Tracker = {
    project: projectName,
    features: features.map((f) => ({
      name: f,
      status: "todo",
      updated_at: new Date().toISOString(),
    })),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  const content = `Progress tracker for ${projectName}. ${features.length} features: ${features.join(", ")}`;
  const vec = await embed(`${projectName} progress tracker`);

  const result = await query<{ id: string }>(
    `INSERT INTO memories (type, title, content, embedding, tags, importance, source, metadata, profile)
     VALUES ('project', $1, $2, $3::vector, $4, 0.8, 'track', $5::jsonb, 'global')
     RETURNING id`,
    [
      `Tracker: ${projectName}`,
      content,
      pgVector(vec),
      ["tracker", projectName.toLowerCase()],
      JSON.stringify({ tracker }),
    ]
  );

  return result.rows[0].id;
}

export async function updateTracker(
  projectName: string,
  featureName: string,
  status: string,
  notes?: string
): Promise<Tracker | null> {
  // Find the tracker
  const result = await query<{ id: string; metadata: { tracker: Tracker } }>(
    `SELECT id, metadata FROM memories
     WHERE type = 'project' AND tags @> ARRAY[$1]
     AND metadata->>'tracker' IS NOT NULL
     LIMIT 1`,
    ["tracker"]
  );

  if (result.rows.length === 0) return null;

  const { id, metadata } = result.rows[0];
  const tracker = metadata.tracker;

  // Find or create the feature
  let feature = tracker.features.find(
    (f) => f.name.toLowerCase() === featureName.toLowerCase()
  );

  if (!feature) {
    feature = {
      name: featureName,
      status: status as TrackerFeature["status"],
      updated_at: new Date().toISOString(),
    };
    tracker.features.push(feature);
  } else {
    feature.status = status as TrackerFeature["status"];
    feature.updated_at = new Date().toISOString();
  }

  if (notes) feature.notes = notes;
  tracker.updated_at = new Date().toISOString();

  // Update content summary
  const done = tracker.features.filter((f) => f.status === "done").length;
  const total = tracker.features.length;
  const content = `Progress tracker for ${projectName}. ${done}/${total} features done. ${tracker.features.map((f) => `${f.name}: ${f.status}`).join(", ")}`;

  await query(
    `UPDATE memories SET metadata = $1::jsonb, content = $2 WHERE id = $3::uuid`,
    [JSON.stringify({ tracker }), content, id]
  );

  return tracker;
}

export async function showTracker(
  projectName?: string
): Promise<Tracker[]> {
  const whereClause = projectName
    ? `AND tags @> ARRAY[$1]`
    : "";
  const params = projectName
    ? ["tracker", projectName.toLowerCase()]
    : ["tracker"];

  const result = await query<{ metadata: { tracker: Tracker } }>(
    `SELECT metadata FROM memories
     WHERE type = 'project' AND tags @> ARRAY[$1]
     AND metadata->>'tracker' IS NOT NULL
     ${projectName ? "AND tags @> ARRAY[$2]" : ""}
     ORDER BY created_at DESC`,
    params
  );

  return result.rows.map((r) => r.metadata.tracker);
}
