/**
 * AlertThresholdRepository — per-customer alert severity thresholds.
 *
 * Thresholds let customers tune how sensitive their alerting is without
 * requiring a service restart.  The values are read by the notification
 * pipeline to decide severity labels, and surfaced/edited via the settings API.
 *
 * Three alert categories are supported out of the box:
 *
 *   environmental  — z-score (sigma) thresholds for temp/humidity/pressure/CO₂
 *   moisture       — moisture percentage thresholds
 *   inventory      — pile volume drop percentage thresholds
 *
 * Platform defaults are returned when a customer has no custom row.  This means
 * the table can start empty; customers only need rows when they deviate from
 * the defaults.
 *
 * Expected DB schema:
 *
 *   CREATE TABLE alert_thresholds (
 *     id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
 *     customer_id     UUID        NOT NULL,
 *     alert_category  TEXT        NOT NULL
 *                       CHECK (alert_category IN ('environmental','moisture','inventory')),
 *     metric          TEXT        NOT NULL DEFAULT '',
 *     warning_value   NUMERIC(10,4) NOT NULL,
 *     critical_value  NUMERIC(10,4) NOT NULL,
 *     unit            TEXT        NOT NULL DEFAULT 'sigma'
 *                       CHECK (unit IN ('sigma','percent','volume')),
 *     enabled         BOOLEAN     NOT NULL DEFAULT TRUE,
 *     created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 *     updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 *     UNIQUE (customer_id, alert_category, metric)
 *   );
 *
 *   CREATE INDEX ON alert_thresholds (customer_id, alert_category);
 */

import { Pool } from "pg";
import { mapDbError } from "../db/errors";
import { toFloat } from "../db/parse";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const ALERT_CATEGORIES = ["environmental", "moisture", "inventory"] as const;
export type  AlertCategory    = typeof ALERT_CATEGORIES[number];

export const THRESHOLD_UNITS = ["sigma", "percent", "volume"] as const;
export type  ThresholdUnit   = typeof THRESHOLD_UNITS[number];

// ---------------------------------------------------------------------------
// Platform defaults — used when a customer has no custom configuration
// ---------------------------------------------------------------------------

export const PLATFORM_DEFAULTS: AlertThreshold[] = [
  {
    id:            "default-env",
    customerId:    "*",
    alertCategory: "environmental",
    metric:        "",
    warningValue:  2.0,
    criticalValue: 3.0,
    unit:          "sigma",
    enabled:       true,
  },
  {
    id:            "default-moisture",
    customerId:    "*",
    alertCategory: "moisture",
    metric:        "",
    warningValue:  15.0,
    criticalValue: 25.0,
    unit:          "percent",
    enabled:       true,
  },
  {
    id:            "default-inventory",
    customerId:    "*",
    alertCategory: "inventory",
    metric:        "",
    warningValue:  10.0,
    criticalValue: 25.0,
    unit:          "percent",
    enabled:       true,
  },
];

// ---------------------------------------------------------------------------
// Domain type
// ---------------------------------------------------------------------------

export interface AlertThreshold {
  id:            string;
  customerId:    string;
  alertCategory: AlertCategory;
  /** Empty string means "applies to all metrics in the category". */
  metric:        string;
  warningValue:  number;
  criticalValue: number;
  unit:          ThresholdUnit;
  enabled:       boolean;
}

// ---------------------------------------------------------------------------
// DB row (NUMERIC columns arrive as strings)
// ---------------------------------------------------------------------------

interface ThresholdRow {
  id:             string;
  customer_id:    string;
  alert_category: string;
  metric:         string;
  warning_value:  string;
  critical_value: string;
  unit:           string;
  enabled:        boolean;
}

function toThreshold(row: ThresholdRow): AlertThreshold {
  return {
    id:            row.id,
    customerId:    row.customer_id,
    alertCategory: row.alert_category as AlertCategory,
    metric:        row.metric,
    warningValue:  toFloat(row.warning_value),
    criticalValue: toFloat(row.critical_value),
    unit:          row.unit as ThresholdUnit,
    enabled:       row.enabled,
  };
}

// ---------------------------------------------------------------------------
// Upsert input
// ---------------------------------------------------------------------------

export interface ThresholdUpsert {
  alertCategory: AlertCategory;
  metric?:       string;
  warningValue:  number;
  criticalValue: number;
  unit:          ThresholdUnit;
  enabled?:      boolean;
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export class AlertThresholdRepository {
  constructor(private readonly pool: Pool) {}

  // ── Read ───────────────────────────────────────────────────────────────────

  /**
   * Return all thresholds for a customer.  Platform defaults are merged in
   * for any category that has no customer-specific row.
   *
   * Customer rows take precedence over defaults.
   */
  async findAll(customerId: string): Promise<AlertThreshold[]> {
    const sql = `
      SELECT id, customer_id, alert_category, metric,
             warning_value::text, critical_value::text,
             unit, enabled
        FROM alert_thresholds
       WHERE customer_id = $1
       ORDER BY alert_category, metric
    `;

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL app.current_customer_id = $1", [customerId]);
      const result = await client.query<ThresholdRow>(sql, [customerId]);
      await client.query("COMMIT");

      const customerThresholds = result.rows.map(toThreshold);

      // Merge defaults for categories the customer hasn't overridden.
      const coveredCategories = new Set(
        customerThresholds.map((t: AlertThreshold) => `${t.alertCategory}:${t.metric}`),
      );
      const defaults = PLATFORM_DEFAULTS.filter(
        (d) => !coveredCategories.has(`${d.alertCategory}:${d.metric}`),
      );

      return [...customerThresholds, ...defaults];
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw mapDbError(err);
    } finally {
      client.release();
    }
  }

  // ── Write ──────────────────────────────────────────────────────────────────

  /**
   * Upsert threshold rows for a customer.
   *
   * Each entry is matched on (customer_id, alert_category, metric).  The full
   * list of thresholds after the operation is returned.
   *
   * Validation (warningValue < criticalValue) is enforced here rather than in
   * the route handler so it cannot be bypassed.
   */
  async upsertMany(
    customerId: string,
    thresholds: ThresholdUpsert[],
  ): Promise<AlertThreshold[]> {
    // Guard: warning must be strictly less than critical.
    for (const t of thresholds) {
      if (t.warningValue >= t.criticalValue) {
        throw new Error(
          `Threshold validation failed for category "${t.alertCategory}"` +
          `: warningValue (${t.warningValue}) must be less than criticalValue (${t.criticalValue})`,
        );
      }
    }

    const sql = `
      INSERT INTO alert_thresholds (
        customer_id, alert_category, metric,
        warning_value, critical_value, unit, enabled, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
      ON CONFLICT (customer_id, alert_category, metric) DO UPDATE SET
        warning_value  = EXCLUDED.warning_value,
        critical_value = EXCLUDED.critical_value,
        unit           = EXCLUDED.unit,
        enabled        = EXCLUDED.enabled,
        updated_at     = NOW()
    `;

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL app.current_customer_id = $1", [customerId]);

      for (const t of thresholds) {
        await client.query(sql, [
          customerId,
          t.alertCategory,
          t.metric   ?? "",
          t.warningValue,
          t.criticalValue,
          t.unit,
          t.enabled  ?? true,
        ]);
      }

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw mapDbError(err);
    } finally {
      client.release();
    }

    // Re-read so the caller gets the full merged list (including defaults).
    return this.findAll(customerId);
  }
}
