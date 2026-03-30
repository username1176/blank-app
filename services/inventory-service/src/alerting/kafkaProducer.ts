import { Kafka, Producer, KafkaConfig, logLevel } from "kafkajs";
import { env } from "../config/env";
import { logger } from "../config/logger";
import { AlertEvent } from "./types";

// ---------------------------------------------------------------------------
// AlertKafkaProducer
// ---------------------------------------------------------------------------

export class AlertKafkaProducer {
  private readonly producer: Producer;
  private connected = false;

  constructor() {
    const brokers = env.KAFKA_BROKERS.split(",").map((b) => b.trim());

    const kafkaConfig: KafkaConfig = {
      clientId: env.KAFKA_CLIENT_ID,
      brokers,
      // Map Winston log levels to KafkaJS levels
      logLevel: env.NODE_ENV === "production" ? logLevel.WARN : logLevel.INFO,
      retry: {
        initialRetryTime: 300,
        retries: 8,
      },
    };

    const kafka = new Kafka(kafkaConfig);
    this.producer = kafka.producer({
      allowAutoTopicCreation: false,
      // Idempotent producer: exactly-once delivery within a session
      idempotent: true,
      maxInFlightRequests: 5,
    });
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    await this.producer.connect();
    this.connected = true;
    logger.info("Kafka producer connected", { topic: env.KAFKA_ALERTS_TOPIC });
  }

  async disconnect(): Promise<void> {
    if (!this.connected) return;
    await this.producer.disconnect();
    this.connected = false;
    logger.info("Kafka producer disconnected");
  }

  /**
   * Publish a single AlertEvent to the configured alerts topic.
   * Uses the pileId as the partition key so all alerts for a pile
   * land on the same partition and preserve ordering.
   */
  async publish(event: AlertEvent): Promise<void> {
    if (!this.connected) {
      throw new Error("Kafka producer is not connected");
    }

    await this.producer.send({
      topic: env.KAFKA_ALERTS_TOPIC,
      messages: [
        {
          key:   event.pileId,
          value: JSON.stringify(event),
          headers: {
            "content-type": "application/json",
            "alert-type":   event.type,
            "severity":     event.severity,
            "customer-id":  event.customerId,
          },
        },
      ],
    });

    logger.debug("Alert event published", {
      alertId:    event.id,
      type:       event.type,
      severity:   event.severity,
      customerId: event.customerId,
      pileId:     event.pileId,
    });
  }
}

// ---------------------------------------------------------------------------
// No-op stub used when KAFKA_ENABLED=false
// ---------------------------------------------------------------------------

export class NoopAlertProducer {
  async connect(): Promise<void> {
    logger.info("Kafka disabled — using no-op alert producer");
  }

  async disconnect(): Promise<void> { /* nothing to do */ }

  async publish(event: AlertEvent): Promise<void> {
    logger.info("Kafka disabled — alert suppressed", {
      alertId:  event.id,
      pileId:   event.pileId,
      severity: event.severity,
    });
  }
}

// ---------------------------------------------------------------------------
// Factory: returns the real producer or the stub based on env config
// ---------------------------------------------------------------------------

export type IAlertProducer = Pick<AlertKafkaProducer, "connect" | "disconnect" | "publish">;

export function createAlertProducer(): IAlertProducer {
  return env.KAFKA_ENABLED
    ? new AlertKafkaProducer()
    : new NoopAlertProducer();
}
