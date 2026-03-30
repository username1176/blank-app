import { Pool, PoolClient, QueryResult } from "pg";
import { mapDbError } from "./errors";

// ---------------------------------------------------------------------------
// Tenant-scoped query helpers
// ---------------------------------------------------------------------------
// All queries that touch RLS-protected tables must set the tenant GUC before
// executing.  Using SET LOCAL inside an explicit transaction confines the GUC
// change to that transaction only, so it can never leak to another request
// that happens to reuse the same pooled connection.
//
// Both helpers wrap every operation in BEGIN / COMMIT so SET LOCAL is safe.
// ---------------------------------------------------------------------------

/**
 * Execute a single SQL statement scoped to a tenant.
 *
 * Acquires a connection, opens a transaction, sets the tenant GUC, runs the
 * query, commits, and releases.  Rolls back and re-throws on any error,
 * converting pg errors to typed DbErrors.
 */
export async function queryTenant<T extends object>(
  pool: Pool,
  customerId: string,
  sql: string,
  params: unknown[] = [],
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
 * Execute multiple statements in a single transaction scoped to a tenant.
 *
 * The callback receives a PoolClient that already has the tenant GUC set.
 * Commit / rollback is handled by the wrapper — do NOT issue them inside `fn`.
 */
export async function withTenantTransaction<T>(
  pool: Pool,
  customerId: string,
  fn: (client: PoolClient) => Promise<T>,
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
