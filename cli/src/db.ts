import pg from "pg";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env from project root
dotenv.config({ path: resolve(__dirname, "../../.env") });

const pool = new pg.Pool({
  host: process.env.CCB_DB_HOST || "localhost",
  port: parseInt(process.env.CCB_DB_PORT || "5432"),
  database: process.env.CCB_DB_NAME || "ccb",
  user: process.env.CCB_DB_USER || "ccb",
  password: process.env.CCB_DB_PASSWORD || "ccb_dev_password",
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

let disconnected = false;
export async function disconnect(): Promise<void> {
  if (disconnected) return;
  disconnected = true;
  await pool.end();
}

export default pool;
