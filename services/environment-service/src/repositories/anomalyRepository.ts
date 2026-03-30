/**
 * AnomalyRepository — persist and query detected anomaly events.
 *
 * Anomaly events are written here immediately after being published to Kafka
 * so they can be surfaced through the REST API without consumers needing to
 * replay the alerts topic.
 *
 * Expected schema (TimescaleDB):
 *
 *   CREATE TABLE sensor_anomalies (
 *     id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
 *     detected_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 *     customer_id      UUID        NOT NULL,
 *     site_id          UUID        NOT NULL,
 *     sensor_id        TEXT        NOT NULL,
 *     sensor_type      TEXT        NOT NULL,
 *     alert_type       TEXT        NOT NULL,
 *     severity         TEXT        NOT NULL,
 *     metric           TEXT        NOT NULL,
 *     current_value    NUMERIC     NOT NULL,
 *     baseline_mean    NUMERIC     NOT NULL,
 *     baseline_std_dev NUMERIC     NOT NULL,
 *     deviation_sigma  NUMERIC     NOT NULL,
 *     warning_sigma    NUMERIC     NOT NULL,
 *     critical_sigma   NUMERIC     NOT NULL,
 *     message          TEXT        NOT NULL
 *   );
 *
 *   SELECT create_hypertable('sensor_anomalies', 'detected_at', if_not_exists => TRUE);
 *   CREATE INDEX ON sensor_anomalies (customer_id, site_id, detected_at DESC);
 *   CREATE INDEX ON sensor_anomalies (customer_id, site_id, sensor_id, detected_at DESC);
 */

import { Pool } from "pg";
import { queryTenant } from "../db/tenant";
import { toFloat } from "../db/parse";
import { AnomalyAlertType, AnomalyEvent, AnomalyMetric, AnomalySeverity } from "../anomaly/types";

// ---------------------------------------------------------------------------
// Domain type
// ---------------------------------------------------------------------------

export interface StoredAnomaly {
  id:             string;
  detectedAt:     Date;
  customerId:     string;
  siteId:         string;
  sensorId:       string;
  sensorType:     string;
  alertType:      AnomalyAlertType;
  severity:       AnomalySeverity;
  metric:         AnomalyMetric;
  currentValue:   number;
  baselineMean:   number;
  baselineStdDev: number;
  deviationSigma: number;
  warningSigma:   number;
  criticalSigma:  number;
  message:        string;
}

// ---------------------------------------------------------------------------
// Raw DB row (NUMERIC arrives as string from pg)
// ---------------------------------------------------------------------------

interface AnomalyRow {
  id:               string;
  detected_at:      Date;
  customer_id:      string;
  site_id:          string;
  sensor_id:        string;
  sensor_type:      string;
  alert_type:       string;
  severity:         string;
  metric:           string;
  current_value:    string;
  baseline_mean:    string;
  baseline_std_dev: string;
  deviation_sigma:  string;
  warning_sigma:    string;
  critical_sigma:   string;
  message:          string;
}

function toStoredAnomaly(row: AnomalyRow): StoredAnomaly {
  return {
    id:             row.id,
    detectedAt:     row.detected_at,
    customerId:     row.customer_id,
    siteId:         row.site_id,
    sensorId:       row.sensor_id,
    sensorType:     row.sensor_type,
    alertType:      row.alert_type as AnomalyAlertType,
    severity:       row.severity   as AnomalySeverity,
    metric:         row.metric     as AnomalyMetric,
    currentValue:   toFloat(row.current_value),
    baselineMean:   toFloat(row.baseline_mean),
    baselineStdDev: toFloat(row.baseline_std_dev),
    deviationSigma: toFloat(row.deviation_sigma),
    warningSigma:   toFloat(row.warning_sigma),
    criticalSigma:  toFloat(row.critical_sigma),
    message:        row.message,
  };
}

// ---------------------------------------------------------------------------
// Query options for findBySite
// ---------------------------------------------------------------------------

export interface FindAnomaliesOptions {
  /** Start of the window (inclusive). Defaults to 24 hours ago. */
  from?:     Date;
  /** End of the window (exclusive). Defaults to now. */
  to?:       Date;
  /** Filter to a specific sensor. */
  sensorId?: string;
  /** Filter to a specific severity level. */
  severity?: AnomalySeverity;
  /** Maximum rows to return. Default 100, max 1 000. */
  limit?:    number;
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export class AnomalyRepository {
  constructor(private readonly pool: Pool) {}

  // ── Persist ───────────────────────────────────────────────────────────────

  /**
   * Store one anomaly event.  Called by AnomalyDetector after a successful
   * Kafka publish.  Failures are non-fatal — the detector catches and logs them.
   */
  async insert(event: AnomalyEvent): Promise<void> {
    const sql = `
      INSERT INTO sensor_anomalies (
        id, detected_at, customer_id, site_id, sensor_id, sensor_type,
        alert_type, severity, metric,
        current_value, baseline_mean, baseline_std_dev, deviation_sigma,
        warning_sigma, critical_sigma, message
      ) VALUES (
        $1, $2, $3, $4, $5, $6,
        $7, $8, $9,
        $10, $11, $12, $13,
        $14, $15, $16
      )
      ON CONFLICT (id) DO NOTHING
    `;

    await queryTenant(this.pool, event.customerId, sql, [
      event.id,
      event.detectedAt,
      event.customerId,
      event.siteId,
      event.sensorId,
      event.sensorType,
      event.type,
      event.severity,
      event.metric,
      event.currentValue,
      event.baselineMean,
      event.baselineStdDev,
      event.deviationSigma,
      event.thresholds.warningSigma,
      event.thresholds.criticalSigma,
      event.message,
    ]);
  }

  // ── Query ─────────────────────────────────────────────────────────────────

  /**
   * Return anomaly events for a site within a time window.
   *
   * Results are ordered newest-first.  Tenant isolation is enforced via the
   * SET LOCAL GUC — a customer cannot see another customer's anomalies.
   */
  async findBySite(
    customerId: string,
    siteId: string,
    opts: FindAnomaliesOptions = {},
  ): Promise<StoredAnomaly[]> {
    const from     = opts.from     ?? new Date(Date.now() - 24 * 60 * 60 * 1000);
    const to       = opts.to       ?? new Date();
    const limit    = Math.min(opts.limit ?? 100, 1000);

    // Build optional filter clauses
    const conditions: string[] = [
      "customer_id = $1",
      "site_id     = $2",
      "detected_at >= $3",
      "detected_at  < $4",
    ];
    const params: unknown[] = [customerId, siteId, from, to];

    if (opts.sensorId !== undefined) {
      params.push(opts.sensorId);
      conditions.push(`sensor_id = $${params.length}`);
    }
    if (opts.severity !== undefined) {
      params.push(opts.severity);
      conditions.push(`severity = $${params.length}`);
    }

    params.push(limit);
    const limitPlaceholder = `$${params.length}`;

    const sql = `
      SELECT id, detected_at, customer_id, site_id, sensor_id, sensor_type,
             alert_type, severity, metric,
             current_value::text, baseline_mean::text, baseline_std_dev::text,
             deviation_sigma::text, warning_sigma::text, critical_sigma::text,
             message
        FROM sensor_anomalies
       WHERE ${conditions.join("\n         AND ")}
       ORDER BY detected_at DESC
       LIMIT ${limitPlaceholder}
    `;

    const result = await queryTenant<AnomalyRow>(
      this.pool, customerId, sql, params,
    );
    return result.rows.map(toStoredAnomaly);
  }
}
