import { query } from "../db.js";
import { embed, pgVector } from "../embeddings.js";

export interface EvolveResult {
  promoted: number;
  clustered: number;
  instincts_checked: number;
}

export async function evolve(): Promise<EvolveResult> {
  const result: EvolveResult = { promoted: 0, clustered: 0, instincts_checked: 0 };

  // Find instincts ready to evolve (high confidence + frequently accessed)
  const evolved = await query<{
    id: string;
    title: string;
    content: string;
    confidence: number;
    access_count: number;
    tags: string[];
  }>(`SELECT * FROM find_evolved_instincts($1::float, $2::int)`, [0.7, 3]);

  result.instincts_checked = evolved.rows.length;

  for (const instinct of evolved.rows) {
    // Find similar instincts to cluster with
    const cluster = await query<{
      id: string;
      title: string;
      content: string;
      similarity: number;
    }>(`SELECT * FROM cluster_instincts($1::uuid, $2::float)`, [instinct.id, 0.7]);

    result.clustered += cluster.rows.length;

    // Merge cluster content into a skill
    const clusterContent = [
      instinct.content,
      ...cluster.rows.map((c) => c.content),
    ].join("\n\n");

    const mergedTitle = `Learned: ${instinct.title}`;
    const mergedTags = [
      "evolved",
      "auto-learned",
      ...instinct.tags.filter((t) => t !== "instinct"),
    ];

    // Create the skill memory
    const vec = await embed(`${mergedTitle} ${clusterContent}`);

    await query(
      `INSERT INTO memories (type, title, content, embedding, tags, importance, confidence, source, profile)
       VALUES ('skill', $1, $2, $3::vector, $4, 0.7, $5::float, 'evolve', 'global')`,
      [mergedTitle, clusterContent, pgVector(vec), mergedTags, instinct.confidence]
    );

    // Mark original instinct and cluster members as superseded
    const allIds = [instinct.id, ...cluster.rows.map((c) => c.id)];
    for (const id of allIds) {
      await query(`DELETE FROM memories WHERE id = $1::uuid AND type = 'instinct'`, [id]);
    }

    // Log the evolution
    await query(
      `INSERT INTO consolidation_log (action, details) VALUES ('evolved', $1::jsonb)`,
      [JSON.stringify({
        from_instinct: instinct.id,
        cluster_size: cluster.rows.length + 1,
        new_skill_title: mergedTitle,
        confidence: instinct.confidence,
      })]
    );

    result.promoted++;
  }

  return result;
}
