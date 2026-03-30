import { Pool, PoolClient } from "pg";
import { env } from "./env";
import { logger } from "./logger";

export const pool = new Pool({
  host:                    env.DB_HOST,
  port:                    env.DB_PORT,
  database:                env.DB_NAME,
  user:                    env.DB_USER,
  password:                env.DB_PASSWORD,
  min:                     env.DB_POOL_MIN,
  max:                     env.DB_POOL_MAX,
  idleTimeoutMillis:       env.DB_IDLE_TIMEOUT_MS,
  connectionTimeoutMillis: env.DB_CONNECTION_TIMEOUT_MS,
  allowExitOnIdle:         false,
});

pool.on("connect", (client: PoolClient) => {
  // Sentinel value: RLS policies require app.current_customer_id to be set
  // before any query on tenant-scoped tables.
  client.query("SET app.current_customer_id = ''").catch(() => undefined);
});

pool.on("error", (err: Error) => {
  logger.error("DB pool: unexpected error on idle client", { error: err.message });
});

/** Verify the pool can reach the database. Returns latency in ms. */
export async function ping(): Promise<number> {
  const start = Date.now();
  await pool.query("SELECT 1");
  return Date.now() - start;
}

/** Check whether TimescaleDB is installed and return its version. */
export async function timescaledbVersion(): Promise<string | null> {
  const result = await pool.query<{ extversion: string }>(
    "SELECT extversion FROM pg_extension WHERE extname = 'timescaledb'",
  );
  return result.rows[0]?.extversion ?? null;
}

/** Gracefully drain the pool (call on SIGTERM / SIGINT). */
export async function closePool(): Promise<void> {
  await pool.end();
  logger.info("DB pool closed");
}
