// ---------------------------------------------------------------------------
// Anomaly detection — shared types
// ---------------------------------------------------------------------------

/** The four alert types this module can raise. */
export type AnomalyAlertType =
  | "temperature_high"
  | "temperature_low"
  | "humidity_high"
  | "humidity_low";

export type AnomalySeverity = "warning" | "critical";

/** Which sensor measurement column is being monitored. */
export type AnomalyMetric = "temperature_c" | "humidity_pct";

// ---------------------------------------------------------------------------
// Baseline
// ---------------------------------------------------------------------------

/**
 * Rolling statistics computed from the last N hours of readings for a
 * specific sensor × metric pair.  Cached in memory to avoid a DB round-trip
 * on every reading.
 */
export interface BaselineStats {
  mean:        number;
  /** Sample standard deviation, floored to prevent false positives in stable environments. */
  stdDev:      number;
  sampleCount: number;
  windowHours: number;
  computedAt:  Date;
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/** Minimum std-dev per metric used when the computed value is very small. */
export const STD_DEV_FLOOR: Record<AnomalyMetric, number> = {
  temperature_c: 0.5,   // 0.5 °C — avoids noise in climate-controlled warehouses
  humidity_pct:  2.0,   // 2 % RH — realistic minimum fluctuation
};

// ---------------------------------------------------------------------------
// Kafka event
// ---------------------------------------------------------------------------

export interface AnomalyEvent {
  /** UUID for idempotency / deduplication downstream. */
  id:             string;
  type:           AnomalyAlertType;
  severity:       AnomalySeverity;
  customerId:     string;
  siteId:         string;
  sensorId:       string;
  sensorType:     string;
  metric:         AnomalyMetric;
  currentValue:   number;
  baselineMean:   number;
  baselineStdDev: number;
  /** How many effective std-devs the reading is from the baseline mean. */
  deviationSigma: number;
  thresholds: {
    warningSigma:  number;
    criticalSigma: number;
  };
  message:    string;
  detectedAt: string; // ISO 8601
}

// ---------------------------------------------------------------------------
// Detector config
// ---------------------------------------------------------------------------

export interface AnomalyDetectorConfig {
  enabled:            boolean;
  baselineWindowHours: number;
  minReadings:        number;
  warningSigma:       number;
  criticalSigma:      number;
  cooldownMinutes:    number;
}

// ---------------------------------------------------------------------------
// Alert producer interface (real vs no-op)
// ---------------------------------------------------------------------------

export interface IAlertProducer {
  connect():                    Promise<void>;
  disconnect():                 Promise<void>;
  publish(event: AnomalyEvent): Promise<void>;
}

// ---------------------------------------------------------------------------
// Reading shape accepted by AnomalyDetector.check()
// ---------------------------------------------------------------------------

export interface ReadingForDetection {
  customerId:   string;
  siteId:       string;
  sensorId:     string;
  sensorType:   string;
  temperatureC: number | null;
  humidityPct:  number | null;
}
