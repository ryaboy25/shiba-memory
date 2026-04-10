import { query } from "../db.js";

export interface ForgetOptions {
  id?: string;
  type?: string;
  olderThan?: string; // e.g. "90d", "30d"
  lowConfidence?: number; // delete memories below this confidence
  expired?: boolean;
}

function parseDuration(expr: string): Date {
  const match = expr.match(/^(\d+)([dhm])$/);
  if (!match) throw new Error(`Invalid duration: ${expr}`);

  const [, num, unit] = match;
  const ms = { d: 86400000, h: 3600000, m: 60000 }[unit]!;
  return new Date(Date.now() - parseInt(num) * ms);
}

export async function forget(opts: ForgetOptions): Promise<number> {
  // Delete by specific ID
  if (opts.id) {
    const result = await query(`DELETE FROM memories WHERE id = $1`, [opts.id]);
    return result.rowCount ?? 0;
  }

  // Clean up expired
  if (opts.expired) {
    const result = await query<{ cleanup_expired: number }>(
      `SELECT cleanup_expired()`
    );
    return result.rows[0].cleanup_expired;
  }

  // Delete by criteria
  const conditions: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (opts.type) {
    conditions.push(`type = $${idx++}`);
    params.push(opts.type);
  }

  if (opts.olderThan) {
    conditions.push(`created_at < $${idx++}`);
    params.push(parseDuration(opts.olderThan));
  }

  if (opts.lowConfidence !== undefined) {
    conditions.push(`confidence < $${idx++}`);
    params.push(opts.lowConfidence);
  }

  if (conditions.length === 0) {
    throw new Error("Must specify at least one filter (--id, --type, --older-than, --low-confidence, or --expired)");
  }

  // Safety: batch deletes with a LIMIT to avoid holding locks for too long.
  // Loop until all matching rows are deleted.
  const BATCH_LIMIT = 500;
  let totalDeleted = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const result = await query(
      `DELETE FROM memories WHERE id IN (
        SELECT id FROM memories WHERE ${conditions.join(" AND ")} LIMIT ${BATCH_LIMIT}
      )`,
      params
    );
    const batch = result.rowCount ?? 0;
    totalDeleted += batch;
    if (batch < BATCH_LIMIT) break;
  }

  return totalDeleted;
}
