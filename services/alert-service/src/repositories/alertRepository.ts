/**
 * AlertRepository — persist consumed Kafka alert messages and serve them
 * through the REST API.
 *
 * Tenant isolation is enforced via the SET LOCAL GUC pattern: every query runs
 * inside a short transaction that sets app.current_customer_id so RLS policies
 * on the alerts table see the correct tenant context.
 *
 * Inserts are idempotent (ON CONFLICT DO NOTHING on the primary key) so
 * Kafka at-least-once delivery cannot produce duplicate rows.
 */

import { Pool } from "pg";
import { mapDbError } from "../db/errors";
import { Alert, AlertPayload, AlertRow, AlertSeverity } from "../types/alert";

// ---------------------------------------------------------------------------
// Row mapper
// ---------------------------------------------------------------------------

function toAlert(row: AlertRow): Alert {
  return {
    id:         row.id,
    receivedAt: row.received_at,
    customerId: row.customer_id,
    siteId:     row.site_id,
    source:     row.source,
    alertType:  row.alert_type,
    severity:   row.severity as AlertSeverity,
    entityId:   row.entity_id,
    entityType: row.entity_type,
    message:    row.message,
    payload:    row.payload,
  };
}

// ---------------------------------------------------------------------------
// Tenant-scoped query helper (inline — avoids a circular db/tenant import)
// ---------------------------------------------------------------------------

async function queryTenant<T>(
  pool: Pool,
  customerId: string,
  sql: string,
  params: unknown[],
): Promise<T[]> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL app.current_customer_id = $1", [customerId]);
    const result = await client.query<T>(sql, params);
    await client.query("COMMIT");
    return result.rows;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw mapDbError(err);
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Query options
// ---------------------------------------------------------------------------

export interface FindAlertsOptions {
  /** Start of the time window (inclusive). Defaults to 24 hours ago. */
  from?:       Date;
  /** End of the time window (exclusive). Defaults to now. */
  to?:         Date;
  /** Filter to a specific site. */
  siteId?:     string;
  /** Filter by severity level. */
  severity?:   AlertSeverity;
  /** Filter by alert type (exact match). */
  alertType?:  string;
  /** Filter by originating service. */
  source?:     string;
  /** Filter by entity (sensor/pile). */
  entityId?:   string;
  /**
   * Cursor-based pagination — pass the receivedAt of the last item from the
   * previous page (ISO string or Date) to get the next page.
   */
  before?:     Date;
  /** Maximum rows to return. Default 50, max 500. */
  limit?:      number;
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export class AlertRepository {
  constructor(private readonly pool: Pool) {}

  // ── Write ─────────────────────────────────────────────────────────────────

  /**
   * Persist one alert event consumed from Kafka.
   *
   * ON CONFLICT DO NOTHING makes the insert idempotent: if the broker
   * redelivers a message the second insert is silently skipped.
   *
   * @param payload   Validated Kafka message payload.
   * @param source    Value of the Kafka "service" header (producer name).
   * @param receivedAt When this service ingested the message (broker timestamp preferred).
   */
  async insert(
    payload:    AlertPayload,
    source:     string,
    receivedAt: Date,
  ): Promise<void> {
    const sql = `
      INSERT INTO alerts (
        id, received_at, customer_id, site_id,
        source, alert_type, severity,
        entity_id, entity_type,
        message, payload
      ) VALUES (
        $1, $2, $3, $4,
        $5, $6, $7,
        $8, $9,
        $10, $11
      )
      ON CONFLICT (id, received_at) DO NOTHING
    `;

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL app.current_customer_id = $1", [payload.customerId]);
      await client.query(sql, [
        payload.id,
        receivedAt,
        payload.customerId,
        payload.siteId      ?? null,
        source,
        payload.type,
        payload.severity,
        payload.entityId    ?? null,
        payload.entityType  ?? null,
        payload.message,
        JSON.stringify(payload),
      ]);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw mapDbError(err);
    } finally {
      client.release();
    }
  }

  // ── Read — list ───────────────────────────────────────────────────────────

  /**
   * List alerts for a tenant.  Supports time-window filtering, optional field
   * filters, and cursor-based pagination (newest-first).
   */
  async findAll(
    customerId: string,
    opts: FindAlertsOptions = {},
  ): Promise<Alert[]> {
    const from  = opts.from  ?? new Date(Date.now() - 24 * 60 * 60 * 1000);
    const to    = opts.to    ?? new Date();
    const limit = Math.min(opts.limit ?? 50, 500);

    const conditions: string[] = [
      "customer_id  = $1",
      "received_at >= $2",
      "received_at  < $3",
    ];
    const params: unknown[] = [customerId, from, to];

    if (opts.before !== undefined) {
      params.push(opts.before);
      conditions.push(`received_at < $${params.length}`);
    }
    if (opts.siteId !== undefined) {
      params.push(opts.siteId);
      conditions.push(`site_id = $${params.length}`);
    }
    if (opts.severity !== undefined) {
      params.push(opts.severity);
      conditions.push(`severity = $${params.length}`);
    }
    if (opts.alertType !== undefined) {
      params.push(opts.alertType);
      conditions.push(`alert_type = $${params.length}`);
    }
    if (opts.source !== undefined) {
      params.push(opts.source);
      conditions.push(`source = $${params.length}`);
    }
    if (opts.entityId !== undefined) {
      params.push(opts.entityId);
      conditions.push(`entity_id = $${params.length}`);
    }

    params.push(limit);
    const limitPlaceholder = `$${params.length}`;

    const sql = `
      SELECT id, received_at, customer_id, site_id,
             source, alert_type, severity,
             entity_id, entity_type,
             message, payload
        FROM alerts
       WHERE ${conditions.join("\n         AND ")}
       ORDER BY received_at DESC
       LIMIT ${limitPlaceholder}
    `;

    const rows = await queryTenant<AlertRow>(this.pool, customerId, sql, params);
    return rows.map(toAlert);
  }

  // ── Read — single ─────────────────────────────────────────────────────────

  /**
   * Fetch a single alert by ID.  Returns null when the ID does not exist or
   * belongs to a different tenant (both cases look the same to the caller).
   */
  async findById(customerId: string, id: string): Promise<Alert | null> {
    const sql = `
      SELECT id, received_at, customer_id, site_id,
             source, alert_type, severity,
             entity_id, entity_type,
             message, payload
        FROM alerts
       WHERE customer_id = $1
         AND id          = $2
       LIMIT 1
    `;

    const rows = await queryTenant<AlertRow>(this.pool, customerId, sql, [customerId, id]);
    const row  = rows[0];
    return row ? toAlert(row) : null;
  }

  // ── Read — summary ────────────────────────────────────────────────────────

  /**
   * Return counts of alerts by severity for a tenant within a time window.
   * Used by the health and dashboard routes.
   */
  async countBySeverity(
    customerId: string,
    from: Date,
    to: Date,
  ): Promise<{ warning: number; critical: number }> {
    const sql = `
      SELECT severity, COUNT(*)::integer AS cnt
        FROM alerts
       WHERE customer_id  = $1
         AND received_at >= $2
         AND received_at  < $3
       GROUP BY severity
    `;

    const rows = await queryTenant<{ severity: string; cnt: number }>(
      this.pool, customerId, sql, [customerId, from, to],
    );

    let warning  = 0;
    let critical = 0;
    for (const row of rows) {
      if (row.severity === "warning")  warning  = row.cnt;
      if (row.severity === "critical") critical = row.cnt;
    }
    return { warning, critical };
  }
}
