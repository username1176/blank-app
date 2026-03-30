import { Pool } from "pg";
import { toFloat, toInt } from "../db/parse";
import { AlertConfig, ResolvedAlertConfig, PileDescriptor, AlertType } from "./types";

// ---------------------------------------------------------------------------
// Raw DB row shapes
// ---------------------------------------------------------------------------

interface AlertConfigRow {
  id:                 string;
  customer_id:        string;
  site_id:            string | null;
  pile_id:            string | null;
  alert_type:         AlertType;
  drop_threshold_pct: string;
  lookback_minutes:   string;
  cooldown_minutes:   string;
  severity:           "info" | "warning" | "critical";
  enabled:            boolean;
  created_at:         Date;
  updated_at:         Date;
}

interface PileRow {
  pile_id:     string;
  pile_name:   string;
  site_id:     string;
  customer_id: string;
}

interface ResolvedRow {
  config_id:          string;
  drop_threshold_pct: string;
  lookback_minutes:   string;
  cooldown_minutes:   string;
  severity:           "info" | "warning" | "critical";
}

// ---------------------------------------------------------------------------
// Mapper
// ---------------------------------------------------------------------------

function toConfig(row: AlertConfigRow): AlertConfig {
  return {
    id:               row.id,
    customerId:       row.customer_id,
    siteId:           row.site_id,
    pileId:           row.pile_id,
    alertType:        row.alert_type,
    dropThresholdPct: toFloat(row.drop_threshold_pct),
    lookbackMinutes:  toInt(row.lookback_minutes),
    cooldownMinutes:  toInt(row.cooldown_minutes),
    severity:         row.severity,
    enabled:          row.enabled,
    createdAt:        row.created_at,
    updatedAt:        row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// AlertConfigRepository
// ---------------------------------------------------------------------------

export class AlertConfigRepository {
  constructor(private readonly pool: Pool) {}

  /**
   * Return every enabled alert_config row across all customers.
   * Called by the scheduler tick — no tenant GUC needed (cross-tenant query).
   * Explicit `enabled = true` filter keeps the result set small.
   */
  async findAllActive(): Promise<AlertConfig[]> {
    const sql = `
      SELECT id, customer_id, site_id, pile_id, alert_type,
             drop_threshold_pct, lookback_minutes, cooldown_minutes,
             severity, enabled, created_at, updated_at
        FROM alert_configs
       WHERE enabled = true
       ORDER BY customer_id, site_id NULLS LAST, pile_id NULLS LAST
    `;

    const result = await this.pool.query<AlertConfigRow>(sql);
    return result.rows.map(toConfig);
  }

  /**
   * Resolve the most specific alert config for a pile using scope precedence:
   *   pile-specific  (customer_id + site_id + pile_id)
   *   site-specific  (customer_id + site_id, pile_id IS NULL)
   *   customer-wide  (customer_id, site_id IS NULL, pile_id IS NULL)
   *
   * Returns null when no enabled config matches.
   * Does NOT use the tenant GUC — caller already scopes by customer_id.
   */
  async resolveForPile(
    customerId: string,
    siteId: string,
    pileId: string,
  ): Promise<ResolvedAlertConfig | null> {
    const sql = `
      SELECT id                AS config_id,
             drop_threshold_pct,
             lookback_minutes,
             cooldown_minutes,
             severity
        FROM alert_configs
       WHERE customer_id = $1
         AND alert_type  = 'inventory_drop'
         AND enabled     = true
         AND (
               -- pile-specific
               (site_id = $2 AND pile_id = $3)
               -- site-specific
            OR (site_id = $2 AND pile_id IS NULL)
               -- customer-wide
            OR (site_id IS NULL AND pile_id IS NULL)
             )
       ORDER BY
         -- Most specific wins (higher score sorts first)
         CASE
           WHEN site_id = $2 AND pile_id = $3 THEN 2
           WHEN site_id = $2 AND pile_id IS NULL THEN 1
           ELSE 0
         END DESC
       LIMIT 1
    `;

    const result = await this.pool.query<ResolvedRow>(sql, [
      customerId,
      siteId,
      pileId,
    ]);

    const row = result.rows[0];
    if (!row) return null;

    return {
      configId:         row.config_id,
      dropThresholdPct: toFloat(row.drop_threshold_pct),
      lookbackMinutes:  toInt(row.lookback_minutes),
      cooldownMinutes:  toInt(row.cooldown_minutes),
      severity:         row.severity,
    };
  }

  /**
   * Return every active pile across all customers.
   * Used by the scheduler to build the full set of piles to check each tick.
   */
  async findActivePiles(): Promise<PileDescriptor[]> {
    const sql = `
      SELECT p.id          AS pile_id,
             p.name        AS pile_name,
             p.site_id,
             p.customer_id
        FROM piles p
       WHERE p.is_active = true
       ORDER BY p.customer_id, p.site_id, p.id
    `;

    const result = await this.pool.query<PileRow>(sql);
    return result.rows.map((r) => ({
      pileId:     r.pile_id,
      pileName:   r.pile_name,
      siteId:     r.site_id,
      customerId: r.customer_id,
    }));
  }

  /**
   * Check whether a cooldown is still active for a pile.
   * Returns true when the most recent alert_log for this pile was fired within
   * the last `cooldownMinutes` and therefore no new alert should fire.
   */
  async isCoolingDown(
    customerId: string,
    pileId: string,
    cooldownMinutes: number,
  ): Promise<boolean> {
    const sql = `
      SELECT 1
        FROM alert_logs
       WHERE customer_id = $1
         AND pile_id     = $2
         AND alert_type  = 'inventory_drop'
         AND fired_at   >= NOW() - ($3 || ' minutes')::INTERVAL
       LIMIT 1
    `;

    const result = await this.pool.query<{ "?column?": number }>(sql, [
      customerId,
      pileId,
      cooldownMinutes,
    ]);

    return result.rowCount !== null && result.rowCount > 0;
  }

  /**
   * Persist a fired alert to alert_logs so cooldown checks work correctly
   * on the next scheduler tick.
   */
  async insertAlertLog(params: {
    customerId: string;
    siteId:     string;
    pileId:     string;
    configId:   string;
    severity:   "info" | "warning" | "critical";
    message:    string;
    details:    Record<string, unknown>;
  }): Promise<void> {
    const sql = `
      INSERT INTO alert_logs
        (customer_id, site_id, pile_id, alert_config_id, alert_type,
         severity, message, details, fired_at)
      VALUES ($1, $2, $3, $4, 'inventory_drop', $5, $6, $7, NOW())
    `;

    await this.pool.query(sql, [
      params.customerId,
      params.siteId,
      params.pileId,
      params.configId,
      params.severity,
      params.message,
      JSON.stringify(params.details),
    ]);
  }
}
