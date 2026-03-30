/**
 * KafkaJS alert producer for environment anomaly events.
 *
 * Partition key: "{siteId}:{sensorId}" — all alerts for a sensor land on the
 * same partition so consumers can rely on per-sensor event ordering.
 *
 * The idempotent producer prevents duplicate messages caused by network
 * retries at the cost of one in-flight request per partition.
 *
 * Set KAFKA_ENABLED=false to use the NoopAlertProducer, which logs a
 * suppressed-alert line instead of connecting to a broker.  This keeps
 * local development broker-free.
 */

import { Kafka, Producer, KafkaConfig, logLevel } from "kafkajs";
import { env } from "../config/env";
import { logger } from "../config/logger";
import { AnomalyEvent, IAlertProducer } from "./types";

// ---------------------------------------------------------------------------
// Real producer
// ---------------------------------------------------------------------------

export class EnvironmentAlertProducer implements IAlertProducer {
  private readonly producer: Producer;
  private connected = false;

  constructor() {
    const brokers = env.KAFKA_BROKERS.split(",").map((b: string) => b.trim());

    const kafkaCfg: KafkaConfig = {
      clientId: env.KAFKA_CLIENT_ID,
      brokers,
      logLevel: env.NODE_ENV === "production" ? logLevel.WARN : logLevel.INFO,
      retry: { initialRetryTime: 300, retries: 8 },
    };

    this.producer = new Kafka(kafkaCfg).producer({
      allowAutoTopicCreation: false,
      idempotent:             true,
      maxInFlightRequests:    5,
    });
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    await this.producer.connect();
    this.connected = true;
    logger.info("Anomaly Kafka producer connected", { topic: env.KAFKA_ALERTS_TOPIC });
  }

  async disconnect(): Promise<void> {
    if (!this.connected) return;
    await this.producer.disconnect();
    this.connected = false;
    logger.info("Anomaly Kafka producer disconnected");
  }

  async publish(event: AnomalyEvent): Promise<void> {
    if (!this.connected) {
      throw new Error("Kafka producer is not connected");
    }

    await this.producer.send({
      topic: env.KAFKA_ALERTS_TOPIC,
      messages: [
        {
          // Partition key: keeps per-sensor events ordered on the same partition
          key:   `${event.siteId}:${event.sensorId}`,
          value: JSON.stringify(event),
          headers: {
            "content-type": "application/json",
            "alert-type":   event.type,
            "severity":     event.severity,
            "customer-id":  event.customerId,
            "service":      "environment-service",
          },
        },
      ],
    });

    logger.debug("Anomaly event published", {
      alertId:  event.id,
      type:     event.type,
      severity: event.severity,
      sensorId: event.sensorId,
    });
  }
}

// ---------------------------------------------------------------------------
// No-op producer (KAFKA_ENABLED=false)
// ---------------------------------------------------------------------------

export class NoopAlertProducer implements IAlertProducer {
  async connect(): Promise<void> {
    logger.info("Kafka disabled — using no-op anomaly alert producer");
  }

  async disconnect(): Promise<void> { /* nothing */ }

  async publish(event: AnomalyEvent): Promise<void> {
    logger.info("Kafka disabled — anomaly alert suppressed", {
      alertId:  event.id,
      type:     event.type,
      severity: event.severity,
      sensorId: event.sensorId,
    });
  }
}
