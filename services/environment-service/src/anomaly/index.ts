/**
 * Anomaly detection module — factory and public API.
 *
 * Call createAnomalyModule(pool) once at startup, then use the returned
 * detector in both the MQTT handler and the REST route handlers.
 *
 *   const anomaly = createAnomalyModule(pool);
 *   await anomaly.connect();          // connects Kafka producer
 *   ...
 *   await anomaly.detector.check(reading);
 *   ...
 *   await anomaly.disconnect();       // on shutdown
 */

import { Pool } from "pg";
import { env } from "../config/env";
import { AnomalyRepository } from "../repositories/anomalyRepository";
import { BaselineCache } from "./baseline";
import { AnomalyDetector } from "./detector";
import { EnvironmentAlertProducer, NoopAlertProducer } from "./kafka";
import { AnomalyDetectorConfig, IAlertProducer } from "./types";

export { AnomalyDetector } from "./detector";
export type { ReadingForDetection, AnomalyEvent } from "./types";

export interface AnomalyModule {
  detector:    AnomalyDetector;
  anomalyRepo: AnomalyRepository;
  connect:     () => Promise<void>;
  disconnect:  () => Promise<void>;
}

export function createAnomalyModule(pool: Pool): AnomalyModule {
  const config: AnomalyDetectorConfig = {
    enabled:             env.ANOMALY_ENABLED,
    baselineWindowHours: env.ANOMALY_BASELINE_WINDOW_HOURS,
    minReadings:         env.ANOMALY_MIN_READINGS,
    warningSigma:        env.ANOMALY_WARNING_SIGMA,
    criticalSigma:       env.ANOMALY_CRITICAL_SIGMA,
    cooldownMinutes:     env.ANOMALY_COOLDOWN_MINUTES,
  };

  const producer: IAlertProducer = env.KAFKA_ENABLED
    ? new EnvironmentAlertProducer()
    : new NoopAlertProducer();

  const baseline    = new BaselineCache();
  const anomalyRepo = new AnomalyRepository(pool);
  const detector    = new AnomalyDetector(pool, baseline, producer, config, anomalyRepo);

  return {
    detector,
    anomalyRepo,
    connect:    () => producer.connect(),
    disconnect: () => producer.disconnect(),
  };
}
