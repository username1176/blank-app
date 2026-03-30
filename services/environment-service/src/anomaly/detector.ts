/**
 * AnomalyDetector — orchestrates baseline lookup, z-score classification,
 * cooldown gating, and Kafka publishing.
 *
 * Detection algorithm
 * -------------------
 * For each measurement in a new reading (temperature, humidity):
 *
 *   1. Fetch (or compute) a rolling baseline of mean ± stdDev over the last
 *      `baselineWindowHours` of readings for that sensor.
 *   2. Compute z-score: σ = |currentValue − mean| / effectiveStdDev
 *      where effectiveStdDev = max(computedStdDev, STD_DEV_FLOOR[metric]).
 *   3. σ >= criticalSigma → severity "critical"
 *      σ >= warningSigma  → severity "warning"
 *      σ <  warningSigma  → no anomaly
 *   4. Check per-(sensor, metric, severity) cooldown window — skip if the same
 *      alert fired within the last `cooldownMinutes`.
 *   5. Publish an AnomalyEvent to Kafka and record the cooldown timestamp.
 *
 * The cooldown is stored in process memory.  It resets on service restart,
 * which is acceptable — a brief burst of duplicate alerts at startup is
 * better than a missed alert.
 */

import { randomUUID } from "crypto";
import { Pool } from "pg";
import { logger } from "../config/logger";
import { AnomalyRepository } from "../repositories/anomalyRepository";
import { BaselineCache } from "./baseline";
import {
  AnomalyAlertType,
  AnomalyDetectorConfig,
  AnomalyEvent,
  AnomalyMetric,
  AnomalySeverity,
  IAlertProducer,
  ReadingForDetection,
} from "./types";

// ---------------------------------------------------------------------------
// Cooldown store
// ---------------------------------------------------------------------------

type CooldownKey = string; // "${sensorId}:${metric}:${severity}"

class CooldownStore {
  private readonly lastFired = new Map<CooldownKey, number>(); // ms epoch

  isActive(sensorId: string, metric: AnomalyMetric, severity: AnomalySeverity, windowMs: number): boolean {
    const last = this.lastFired.get(this._key(sensorId, metric, severity));
    return last !== undefined && Date.now() - last < windowMs;
  }

  record(sensorId: string, metric: AnomalyMetric, severity: AnomalySeverity): void {
    this.lastFired.set(this._key(sensorId, metric, severity), Date.now());
  }

  private _key(sensorId: string, metric: AnomalyMetric, severity: AnomalySeverity): CooldownKey {
    return `${sensorId}:${metric}:${severity}`;
  }
}

// ---------------------------------------------------------------------------
// AnomalyDetector
// ---------------------------------------------------------------------------

export class AnomalyDetector {
  private readonly cooldown = new CooldownStore();

  constructor(
    private readonly pool:          Pool,
    private readonly baseline:      BaselineCache,
    private readonly producer:      IAlertProducer,
    private readonly config:        AnomalyDetectorConfig,
    private readonly anomalyRepo:   AnomalyRepository | null = null,
  ) {}

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Check a freshly-persisted reading for anomalies.
   *
   * Called after every successful DB insert (REST and MQTT paths).  Never
   * throws — any internal error is logged so the caller's response is
   * unaffected.
   */
  async check(reading: ReadingForDetection): Promise<void> {
    if (!this.config.enabled) return;

    const checks: Array<{ metric: AnomalyMetric; value: number | null }> = [
      { metric: "temperature_c", value: reading.temperatureC },
      { metric: "humidity_pct",  value: reading.humidityPct  },
    ];

    for (const { metric, value } of checks) {
      if (value === null) continue;
      await this._checkMetric(reading, metric, value).catch((err) => {
        logger.error("Anomaly: metric check threw unexpectedly", {
          sensorId: reading.sensorId, metric,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private async _checkMetric(
    reading:      ReadingForDetection,
    metric:       AnomalyMetric,
    currentValue: number,
  ): Promise<void> {
    const { customerId, siteId, sensorId, sensorType } = reading;

    // ── Fetch baseline ────────────────────────────────────────────────────────
    const stats = await this.baseline.get(
      this.pool,
      customerId,
      siteId,
      sensorId,
      metric,
      this.config.baselineWindowHours,
      this.config.minReadings,
    );

    if (!stats) return; // not enough historical data yet

    // ── Compute z-score ───────────────────────────────────────────────────────
    const sigma = Math.abs(currentValue - stats.mean) / stats.stdDev;

    let severity: AnomalySeverity | null = null;
    if      (sigma >= this.config.criticalSigma) severity = "critical";
    else if (sigma >= this.config.warningSigma)  severity = "warning";

    if (!severity) return; // within normal range

    // ── Cooldown check ────────────────────────────────────────────────────────
    const cooldownMs = this.config.cooldownMinutes * 60 * 1000;
    if (this.cooldown.isActive(sensorId, metric, severity, cooldownMs)) {
      logger.debug("Anomaly: suppressed by cooldown", { sensorId, metric, severity });
      return;
    }

    // ── Build and publish event ───────────────────────────────────────────────
    const direction = currentValue > stats.mean ? "high" : "low";
    const alertType = `${metric === "temperature_c" ? "temperature" : "humidity"}_${direction}` as AnomalyAlertType;

    const event: AnomalyEvent = {
      id:             randomUUID(),
      type:           alertType,
      severity,
      customerId,
      siteId,
      sensorId,
      sensorType,
      metric,
      currentValue,
      baselineMean:   stats.mean,
      baselineStdDev: stats.stdDev,
      deviationSigma: Math.round(sigma * 100) / 100,
      thresholds: {
        warningSigma:  this.config.warningSigma,
        criticalSigma: this.config.criticalSigma,
      },
      message: this._buildMessage(metric, currentValue, stats.mean, sigma, severity),
      detectedAt: new Date().toISOString(),
    };

    try {
      await this.producer.publish(event);
      this.cooldown.record(sensorId, metric, severity);

      logger.info("Anomaly detected and published", {
        alertId:    event.id,
        type:       alertType,
        severity,
        sensorId,
        metric,
        currentValue,
        baselineMean:   Math.round(stats.mean * 100) / 100,
        deviationSigma: event.deviationSigma,
      });

      // Persist to DB so the REST API can surface anomalies without a Kafka consumer.
      // Non-fatal: a DB failure must not prevent the Kafka event from being recorded.
      if (this.anomalyRepo) {
        this.anomalyRepo.insert(event).catch((dbErr: unknown) => {
          logger.error("Anomaly: failed to persist event to DB", {
            alertId: event.id, sensorId, metric,
            error: dbErr instanceof Error ? dbErr.message : String(dbErr),
          });
        });
      }
    } catch (err) {
      logger.error("Anomaly: failed to publish event", {
        alertId: event.id, sensorId, metric,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private _buildMessage(
    metric:       AnomalyMetric,
    value:        number,
    mean:         number,
    sigma:        number,
    severity:     AnomalySeverity,
  ): string {
    const label = metric === "temperature_c" ? "Temperature" : "Humidity";
    const unit  = metric === "temperature_c" ? "°C"          : "% RH";
    const direction = value > mean ? "above" : "below";
    return (
      `${severity === "critical" ? "CRITICAL" : "Warning"}: ` +
      `${label} ${value.toFixed(2)}${unit} is ${direction} baseline ` +
      `(mean ${mean.toFixed(2)}${unit}, ${sigma.toFixed(1)}σ deviation)`
    );
  }
}
