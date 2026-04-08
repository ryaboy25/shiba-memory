import { query } from "../db.js";
import { embed, pgVector } from "../embeddings.js";
import { isLLMAvailable, llmChat } from "../llm.js";

export interface EvolveResult {
  promoted: number;
  clustered: number;
  instincts_checked: number;
  llm_verified: number;
}

/**
 * Tier 3: Use LLM to verify whether an instinct is a real pattern worth promoting.
 * Returns true if the LLM confirms it's a real pattern.
 */
async function verifyInstinct(title: string, content: string, accessCount: number): Promise<boolean> {
  if (!isLLMAvailable()) return true; // Without LLM, trust the numbers

  const response = await llmChat([
    {
      role: "system",
      content: `You evaluate whether an observed pattern is worth promoting to a permanent skill. Reply with JSON: {"promote": true/false, "reason": "why"}`,
    },
    {
      role: "user",
      content: `Pattern: "${title}"\nDetails: ${content.slice(0, 300)}\nObserved ${accessCount} times.\n\nIs this a real, actionable pattern worth remembering permanently?`,
    },
  ], 150);

  if (!response) return true; // LLM failure → trust the numbers
  return !response.toLowerCase().includes('"promote": false') && !response.toLowerCase().includes('"promote":false');
}

export async function evolve(): Promise<EvolveResult> {
  const result: EvolveResult = { promoted: 0, clustered: 0, instincts_checked: 0, llm_verified: 0 };

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
    // Tier 3: LLM verification before promotion
    const verified = await verifyInstinct(instinct.title, instinct.content, instinct.access_count);
    if (verified) result.llm_verified++;
    if (!verified) continue; // LLM says not a real pattern — skip

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

    const vec = await embed(`${mergedTitle} ${clusterContent}`);

    await query(
      `INSERT INTO memories (type, title, content, embedding, tags, importance, confidence, source, profile)
       VALUES ('skill', $1, $2, $3::vector, $4, 0.7, $5::float, 'evolve', 'global')`,
      [mergedTitle, clusterContent, pgVector(vec), mergedTags, instinct.confidence]
    );

    // Delete original instinct and cluster members
    const allIds = [instinct.id, ...cluster.rows.map((c) => c.id)];
    for (const id of allIds) {
      await query(`DELETE FROM memories WHERE id = $1::uuid AND type = 'instinct'`, [id]);
    }

    await query(
      `INSERT INTO consolidation_log (action, details) VALUES ('evolved', $1::jsonb)`,
      [JSON.stringify({
        from_instinct: instinct.id,
        cluster_size: cluster.rows.length + 1,
        new_skill_title: mergedTitle,
        confidence: instinct.confidence,
        llm_verified: verified,
      })]
    );

    result.promoted++;
  }

  return result;
}
