/**
 * Kafka message handler for the alerts topic.
 *
 * Each incoming message goes through four steps:
 *   1. Deserialise — parse the value as UTF-8 JSON.
 *   2. Validate    — run the Zod schema; reject malformed payloads.
 *   3. Enrich      — extract metadata from Kafka headers (source service,
 *                    alert-type, customer-id) as fallbacks for missing fields.
 *   4. Persist     — upsert via AlertRepository (idempotent on message id).
 *
 * The handler never throws.  Failures are logged and counted; the consumer
 * continues processing subsequent messages.
 */

import { EachMessagePayload } from "kafkajs";
import { logger } from "../config/logger";
import { AlertRepository } from "../repositories/alertRepository";
import { NotificationRouter } from "../notifications/router";
import { AlertPayload, alertPayloadSchema, headerToString } from "../types/alert";

// ---------------------------------------------------------------------------
// Metrics — module-level so they survive handler re-creation
// ---------------------------------------------------------------------------

let _received  = 0;
let _accepted  = 0;
let _rejected  = 0;

export function getHandlerStats(): { received: number; accepted: number; rejected: number } {
  return { received: _received, accepted: _accepted, rejected: _rejected };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Returns a bound message handler.
 *
 * @param alertRepo          Repository used to persist consumed alerts.
 * @param notificationRouter Optional router — when provided, a fire-and-forget
 *                           notification dispatch is triggered after each
 *                           successful persist.  Omit to process alerts without
 *                           sending notifications (useful in test envs).
 */
export function createMessageHandler(
  alertRepo:            AlertRepository,
  notificationRouter:   NotificationRouter | null = null,
): (payload: EachMessagePayload) => Promise<void> {

  return async function handleMessage(
    { topic, partition, message }: EachMessagePayload,
  ): Promise<void> {
    _received++;

    // ── 1. Deserialise ────────────────────────────────────────────────────────
    if (!message.value) {
      logger.warn("Kafka: received message with empty value", { topic, partition, offset: message.offset });
      _rejected++;
      return;
    }

    let raw: unknown;
    try {
      raw = JSON.parse(message.value.toString("utf8"));
    } catch {
      logger.warn("Kafka: message value is not valid JSON", {
        topic,
        partition,
        offset:  message.offset,
        preview: message.value.toString("utf8").slice(0, 200),
      });
      _rejected++;
      return;
    }

    // ── 2. Validate ───────────────────────────────────────────────────────────
    const parsed = alertPayloadSchema.safeParse(raw);
    if (!parsed.success) {
      logger.warn("Kafka: alert payload failed schema validation", {
        topic,
        partition,
        offset: message.offset,
        errors: parsed.error.flatten().fieldErrors,
      });
      _rejected++;
      return;
    }

    let payload: AlertPayload = parsed.data;

    // ── 3. Enrich from headers ────────────────────────────────────────────────
    // Headers are the authoritative source for routing metadata when present.
    // They act as fallbacks for any field that the payload might omit.
    const headers = message.headers ?? {};
    const source  = headerToString(headers["service"] as Buffer | string | undefined)
                 ?? "unknown";

    // Some producers include customer-id in the header for routing without
    // having to parse the full payload.  Validate it matches the payload.
    const headerCustomerId = headerToString(
      headers["customer-id"] as Buffer | string | undefined,
    );
    if (headerCustomerId && headerCustomerId !== payload.customerId) {
      logger.warn("Kafka: header customer-id does not match payload customerId", {
        topic,
        partition,
        offset:          message.offset,
        headerCustomerId,
        payloadCustomerId: payload.customerId,
      });
      // Trust the payload — header mismatch is logged but not fatal.
    }

    // ── 4. Persist ────────────────────────────────────────────────────────────
    // Use the Kafka broker timestamp as received_at when available; fall back
    // to the current time.  This gives accurate latency metrics.
    const receivedAt = message.timestamp
      ? new Date(Number(message.timestamp))
      : new Date();

    try {
      await alertRepo.insert(payload, source, receivedAt);
      _accepted++;

      logger.debug("Kafka: alert persisted", {
        alertId:    payload.id,
        type:       payload.type,
        severity:   payload.severity,
        customerId: payload.customerId,
        source,
        offset:     message.offset,
        partition,
      });

      // ── 5. Route notifications ──────────────────────────────────────────────
      // Fire-and-forget: notification delivery must never delay offset commit
      // or block the consumer from processing the next message.
      if (notificationRouter) {
        notificationRouter.route(payload, source).catch((err: unknown) => {
          logger.error("Kafka: notification routing threw unexpectedly", {
            alertId:    payload.id,
            customerId: payload.customerId,
            error:      err instanceof Error ? err.message : String(err),
          });
        });
      }
    } catch (err) {
      _rejected++;
      logger.error("Kafka: failed to persist alert", {
        alertId:    payload.id,
        customerId: payload.customerId,
        source,
        topic,
        partition,
        offset:     message.offset,
        error:      err instanceof Error ? err.message : String(err),
      });
      // Do not re-throw: KafkaJS will still commit the offset and continue.
      // A persistent DB failure will eventually surface through health checks.
    }
  };
}
