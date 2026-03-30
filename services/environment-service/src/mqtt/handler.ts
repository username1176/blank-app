/**
 * MQTT message ingestion handler.
 *
 * Registered once on the MqttIngestionClient at startup.  For every incoming
 * message it:
 *   1. Parses the topic to extract customerId / siteId / sensorId.
 *   2. JSON-parses and Zod-validates the payload.
 *   3. Inserts the reading via SensorReadingRepository.
 *   4. Logs success or validation/parse errors (never throws — a bad message
 *      must not crash the process or affect subsequent messages).
 */

import { Pool } from "pg";
import { logger } from "../config/logger";
import { SensorReadingRepository } from "../repositories/sensorReadingRepository";
import { mqttPayloadSchema } from "../types/sensorReading";
import { parseTopic } from "./topics";

// Metrics counters — exposed via GET /health for operational visibility.
let _received  = 0;
let _accepted  = 0;
let _rejected  = 0;

export function getMqttStats(): { received: number; accepted: number; rejected: number } {
  return { received: _received, accepted: _accepted, rejected: _rejected };
}

// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------

/**
 * Returns the message handler function bound to the given pg Pool.
 * The repository is created per-message (it holds no state — just the pool).
 */
export function createMessageHandler(pool: Pool) {
  const repo = new SensorReadingRepository(pool);

  return async function handleMessage(
    topic: string,
    payload: Buffer,
  ): Promise<void> {
    _received++;

    // ── 1. Parse topic ────────────────────────────────────────────────────────
    const topicParams = parseTopic(topic);
    if (!topicParams) {
      logger.warn("MQTT: ignoring message on unexpected topic", { topic });
      _rejected++;
      return;
    }
    const { customerId, siteId, sensorId } = topicParams;

    // ── 2. Parse payload ──────────────────────────────────────────────────────
    let raw: unknown;
    try {
      raw = JSON.parse(payload.toString("utf8"));
    } catch {
      logger.warn("MQTT: payload is not valid JSON", {
        topic,
        payloadPreview: payload.toString("utf8").slice(0, 100),
      });
      _rejected++;
      return;
    }

    const parsed = mqttPayloadSchema.safeParse(raw);
    if (!parsed.success) {
      logger.warn("MQTT: payload validation failed", {
        topic,
        errors: parsed.error.flatten().fieldErrors,
      });
      _rejected++;
      return;
    }

    const msg = parsed.data;

    // ── 3. Persist ────────────────────────────────────────────────────────────
    try {
      await repo.insert(customerId, {
        siteId,
        sensorId,
        sensorType:        msg.sensor_type,
        temperatureC:      msg.temperature_c      ?? null,
        humidityPct:       msg.humidity_pct       ?? null,
        pressureHpa:       msg.pressure_hpa       ?? null,
        co2Ppm:            msg.co2_ppm            ?? null,
        batteryPct:        msg.battery_pct        ?? null,
        signalStrengthDbm: msg.signal_strength_dbm ?? null,
        time:              msg.timestamp ? new Date(msg.timestamp) : undefined,
      });

      _accepted++;

      logger.debug("MQTT: reading ingested", {
        customerId,
        siteId,
        sensorId,
        sensorType: msg.sensor_type,
      });
    } catch (err) {
      // DB failures are logged but not re-thrown so the handler loop continues.
      logger.error("MQTT: failed to persist reading", {
        topic,
        customerId,
        sensorId,
        error: err instanceof Error ? err.message : String(err),
      });
      _rejected++;
    }
  };
}
