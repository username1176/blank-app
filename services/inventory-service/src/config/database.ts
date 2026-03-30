import { Pool, PoolClient } from "pg";
import { env } from "./env";
import { logger } from "./logger";

// ---------------------------------------------------------------------------
// Connection pool
// ---------------------------------------------------------------------------
// TimescaleDB is a PostgreSQL extension — the standard `pg` driver is used
// without modification.  The pool is created once at module load time and
// reused across all requests.
// ---------------------------------------------------------------------------

export const pool = new Pool({
  host: env.DB_HOST,
  port: env.DB_PORT,
  database: env.DB_NAME,
  user: env.DB_USER,
  password: env.DB_PASSWORD,
  min: env.DB_POOL_MIN,
  max: env.DB_POOL_MAX,
  idleTimeoutMillis: env.DB_IDLE_TIMEOUT_MS,
  connectionTimeoutMillis: env.DB_CONNECTION_TIMEOUT_MS,
  // Surface connection errors immediately instead of queuing indefinitely
  allowExitOnIdle: false,
});

pool.on("connect", (client: PoolClient) => {
  logger.debug("DB pool: new client connected", {
    host: env.DB_HOST,
    database: env.DB_NAME,
  });
  // Enforce tenant isolation for every connection obtained from the pool.
  // The application layer must call setTenantId() before issuing any query.
  client.query("SET app.current_customer_id = ''").catch(() => {
    // Non-fatal at connect time; setTenantId() will set the correct value.
  });
});

pool.on("error", (err: Error) => {
  logger.error("DB pool: unexpected error on idle client", { error: err.message });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Run a single query against the pool. */
export async function query<T extends object = Record<string, unknown>>(
  sql: string,
  params?: unknown[],
): Promise<T[]> {
  const { rows } = await pool.query<T>(sql, params);
  return rows;
}

/** Acquire a dedicated client for multi-statement transactions. */
export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Set the tenant GUC for the current transaction / session.
 * Must be called before any RLS-protected query.
 */
export async function setTenantId(
  client: PoolClient,
  customerId: string,
): Promise<void> {
  await client.query("SET LOCAL app.current_customer_id = $1", [customerId]);
}

/** Verify the pool can reach the database. Returns latency in ms. */
export async function ping(): Promise<number> {
  const start = Date.now();
  await pool.query("SELECT 1");
  return Date.now() - start;
}

/** Check whether the TimescaleDB extension is installed and its version. */
export async function timescaledbVersion(): Promise<string | null> {
  const rows = await query<{ default_version: string }>(
    "SELECT default_version FROM pg_available_extensions WHERE name = 'timescaledb'",
  );
  return rows[0]?.default_version ?? null;
}

/** Gracefully drain the pool (call on SIGTERM / SIGINT). */
export async function closePool(): Promise<void> {
  await pool.end();
  logger.info("DB pool closed");
}
