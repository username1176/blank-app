import { Pool, QueryResult } from "pg";
import { mapDbError } from "./errors";

/**
 * Execute a single SQL statement inside a BEGIN/SET LOCAL/COMMIT block so
 * the tenant GUC is confined to this transaction and cannot leak across
 * pooled connections.
 */
export async function queryTenant<T>(
  pool: Pool,
  customerId: string,
  sql: string,
  params: unknown[],
): Promise<QueryResult<T>> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL app.current_customer_id = $1", [customerId]);
    const result = await client.query<T>(sql, params);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw mapDbError(err);
  } finally {
    client.release();
  }
}

/**
 * Run multiple statements inside a single tenant-scoped transaction.
 * The callback receives a client with the tenant GUC already set.
 */
export async function withTenantTransaction<T>(
  pool: Pool,
  customerId: string,
  fn: (client: import("pg").PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL app.current_customer_id = $1", [customerId]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw mapDbError(err);
  } finally {
    client.release();
  }
}
