import { readFileSync, readdirSync } from "fs";
import { resolve, basename, dirname } from "path";
import { createHash } from "crypto";
import { fileURLToPath } from "url";
import { query, getClient } from "../db.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_DIR = resolve(__dirname, "../../../schema");

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export async function migrate(): Promise<{ applied: string[]; skipped: string[] }> {
  // Ensure migrations_log table exists
  await query(`
    CREATE TABLE IF NOT EXISTS migrations_log (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      filename TEXT NOT NULL UNIQUE,
      checksum TEXT NOT NULL,
      applied_at TIMESTAMPTZ DEFAULT now()
    )
  `);

  // Get already-applied migrations
  const applied = await query<{ filename: string; checksum: string }>(
    `SELECT filename, checksum FROM migrations_log ORDER BY filename`
  );
  const appliedSet = new Map(applied.rows.map((r) => [r.filename, r.checksum]));

  // Auto-bootstrap: if memories table exists but no migrations logged,
  // seed the initial migrations as already applied
  if (appliedSet.size === 0) {
    const tables = await query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = 'memories'`
    );
    if (tables.rows.length > 0) {
      const bootstrapFiles = readdirSync(SCHEMA_DIR)
        .filter((f) => f.endsWith(".sql"))
        .sort();
      for (const file of bootstrapFiles) {
        const content = readFileSync(resolve(SCHEMA_DIR, file), "utf-8");
        await query(
          `INSERT INTO migrations_log (filename, checksum) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [file, sha256(content)]
        );
      }
      // Re-fetch after bootstrap
      const refreshed = await query<{ filename: string; checksum: string }>(
        `SELECT filename, checksum FROM migrations_log ORDER BY filename`
      );
      for (const r of refreshed.rows) appliedSet.set(r.filename, r.checksum);
    }
  }

  // Find and apply pending migrations
  const allFiles = readdirSync(SCHEMA_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const result = { applied: [] as string[], skipped: [] as string[] };

  for (const file of allFiles) {
    const content = readFileSync(resolve(SCHEMA_DIR, file), "utf-8");
    const checksum = sha256(content);

    if (appliedSet.has(file)) {
      const existingChecksum = appliedSet.get(file);
      if (existingChecksum !== checksum) {
        console.warn(`WARNING: ${file} has changed since it was applied (checksum mismatch)`);
      }
      result.skipped.push(file);
      continue;
    }

    // Apply migration in a transaction
    const client = await getClient();
    try {
      await client.query("BEGIN");
      await client.query(content);
      await client.query(
        `INSERT INTO migrations_log (filename, checksum) VALUES ($1, $2)`,
        [file, checksum]
      );
      await client.query("COMMIT");
      result.applied.push(file);
    } catch (e) {
      await client.query("ROLLBACK");
      throw new Error(`Migration ${file} failed: ${(e as Error).message}`);
    } finally {
      client.release();
    }
  }

  return result;
}
