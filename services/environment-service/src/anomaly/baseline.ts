/**
 * BaselineCache — rolling statistics for temperature and humidity per sensor.
 *
 * Design
 * ------
 * Baseline stats are computed from the last N hours of readings for a given
 * {customerId, siteId, sensorId, metric} tuple.  Results are cached in an
 * in-memory Map with a 5-minute TTL so the DB is not hit on every reading.
 *
 * At 50 sensors × 2 metrics × ~200 bytes per entry the working set is ~20 KB —
 * negligible memory overhead even for large deployments.
 *
 * SQL uses STDDEV_SAMP (sample std dev, N-1 denominator) because we are
 * working with a sample of a continuous physical process, not its whole
 * population.
 */

import { Pool } from "pg";
import { logger } from "../config/logger";
import { AnomalyMetric, BaselineStats, STD_DEV_FLOOR } from "./types";

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface CachedEntry extends BaselineStats {
  expiresAt: Date;
}

interface StatsRow {
  sample_count: string;
  mean:         string | null;
  std_dev:      string | null;
}

export class BaselineCache {
  private readonly cache = new Map<string, CachedEntry>();

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Return cached baseline stats, computing them from the DB if the cache is
   * stale or missing.  Returns null when there are fewer than minReadings in
   * the window (not enough data to establish a baseline).
   */
  async get(
    pool:          Pool,
    customerId:    string,
    siteId:        string,
    sensorId:      string,
    metric:        AnomalyMetric,
    windowHours:   number,
    minReadings:   number,
  ): Promise<BaselineStats | null> {
    const key    = this._key(customerId, siteId, sensorId, metric);
    const cached = this.cache.get(key);

    if (cached && cached.expiresAt > new Date()) {
      return cached;
    }

    const stats = await this._compute(pool, customerId, siteId, sensorId, metric, windowHours);

    if (stats === null || stats.sampleCount < minReadings) {
      logger.debug("Anomaly baseline: insufficient data — skipping", {
        sensorId, metric, sampleCount: stats?.sampleCount ?? 0, minReadings,
      });
      return null;
    }

    const entry: CachedEntry = {
      ...stats,
      expiresAt: new Date(Date.now() + CACHE_TTL_MS),
    };
    this.cache.set(key, entry);
    return entry;
  }

  /** Immediately evict a single sensor's cache entries (both metrics). */
  invalidate(customerId: string, siteId: string, sensorId: string): void {
    for (const metric of ["temperature_c", "humidity_pct"] as AnomalyMetric[]) {
      this.cache.delete(this._key(customerId, siteId, sensorId, metric));
    }
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private async _compute(
    pool:        Pool,
    customerId:  string,
    siteId:      string,
    sensorId:    string,
    metric:      AnomalyMetric,
    windowHours: number,
  ): Promise<BaselineStats | null> {
    // The metric column name is one of a fixed enum — safe to interpolate.
    const sql = `
      SELECT
        COUNT(${metric})::integer                AS sample_count,
        AVG(${metric})                           AS mean,
        STDDEV_SAMP(${metric})                   AS std_dev
        FROM sensor_readings
       WHERE customer_id = $1
         AND site_id     = $2
         AND sensor_id   = $3
         AND ${metric} IS NOT NULL
         AND time >= NOW() - ($4 * INTERVAL '1 hour')
    `;

    try {
      const result = await pool.query<StatsRow>(sql, [
        customerId,
        siteId,
        sensorId,
        windowHours,
      ]);

      const row = result.rows[0];
      if (!row || row.mean === null) return null;

      const sampleCount = parseInt(row.sample_count, 10);
      const mean        = parseFloat(row.mean);
      const rawStdDev   = row.std_dev !== null ? parseFloat(row.std_dev) : 0;
      // Apply floor so a perfectly stable sensor never triggers on micro-noise.
      const stdDev      = Math.max(rawStdDev, STD_DEV_FLOOR[metric]);

      return {
        mean,
        stdDev,
        sampleCount,
        windowHours,
        computedAt: new Date(),
      };
    } catch (err) {
      logger.error("Anomaly baseline: DB query failed", {
        sensorId, metric,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  private _key(
    customerId: string,
    siteId:     string,
    sensorId:   string,
    metric:     AnomalyMetric,
  ): string {
    return `${customerId}:${siteId}:${sensorId}:${metric}`;
  }
}
