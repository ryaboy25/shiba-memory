import pg from "pg";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env from project root
dotenv.config({ path: resolve(__dirname, "../../.env") });

const pool = new pg.Pool({
  host: process.env.SHB_DB_HOST || "localhost",
  port: parseInt(process.env.SHB_DB_PORT || "5432"),
  database: process.env.SHB_DB_NAME || "shb",
  user: process.env.SHB_DB_USER || "shb",
  password: process.env.SHB_DB_PASSWORD || "shb_dev_password",
  max: 5,
  idleTimeoutMillis: 30000,
});

export async function query<T extends pg.QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<pg.QueryResult<T>> {
  return pool.query<T>(text, params);
}

export async function getClient(): Promise<pg.PoolClient> {
  return pool.connect();
}

/** Run a function within a transaction. Auto-commits on success, rolls back on error. */
export async function withTransaction<T>(
  fn: (txQuery: <R extends pg.QueryResultRow>(text: string, params?: unknown[]) => Promise<pg.QueryResult<R>>) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const txQuery = <R extends pg.QueryResultRow>(text: string, params?: unknown[]) =>
      client.query<R>(text, params);
    const result = await fn(txQuery);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

let disconnected = false;
export async function disconnect(): Promise<void> {
  if (disconnected) return;
  disconnected = true;
  await pool.end();
}

export default pool;
