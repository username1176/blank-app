/**
 * Health endpoints.
 *
 * GET /health        Full dependency check — returns 200 or 503.
 * GET /health/live   Kubernetes liveness probe — always 200 while process runs.
 * GET /health/ready  Kubernetes readiness probe — DB-only check.
 *
 * Response shape for GET /health:
 * {
 *   "status":    "ok" | "degraded",
 *   "uptime":    123.4,
 *   "timestamp": "...",
 *   "checks": {
 *     "database": {
 *       "status": "ok" | "error",
 *       "latencyMs": 4,
 *       "timescaledb": "2.14.2"
 *     },
 *     "kafka": {
 *       "status": "ok" | "degraded" | "disabled",
 *       "consumerState": "running" | "stopped" | ...,
 *       "stats": { consumed, processed, failed, lastHeartbeatAt, lastMessageAt }
 *     }
 *   }
 * }
 */

import { Router, Request, Response } from "express";
import { ping, timescaledbVersion } from "../config/database";
import { logger } from "../config/logger";
import { AlertConsumer, ConsumerStats, NoopAlertConsumer } from "../kafka/consumer";
import { getHandlerStats } from "../kafka/handler";

export function createHealthRouter(
  consumer: AlertConsumer | NoopAlertConsumer,
): Router {
  const router = Router();

  // ── GET /health ────────────────────────────────────────────────────────────

  router.get("/health", async (_req: Request, res: Response) => {
    // Database check
    let dbOk = false;
    let dbCheck: Record<string, unknown>;

    try {
      const [latencyMs, tsdbVersion] = await Promise.all([
        ping(),
        timescaledbVersion(),
      ]);
      dbCheck = { status: "ok", latencyMs, timescaledb: tsdbVersion };
      dbOk    = true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn("Health check: database unreachable", { error: message });
      dbCheck = { status: "error", error: message };
    }

    // Kafka consumer check
    const consumerStats: ConsumerStats = consumer.stats;
    const kafkaDisabled = consumerStats.state === "disabled";
    const kafkaOk       = kafkaDisabled || consumerStats.state === "running";

    const handlerStats = getHandlerStats();
    const kafkaCheck: Record<string, unknown> = {
      status:        kafkaDisabled ? "disabled" : kafkaOk ? "ok" : "degraded",
      consumerState: consumerStats.state,
      stats: {
        consumed:        consumerStats.consumed,
        processed:       consumerStats.processed,
        failed:          consumerStats.failed,
        handlerReceived: handlerStats.received,
        handlerAccepted: handlerStats.accepted,
        handlerRejected: handlerStats.rejected,
        lastHeartbeatAt: consumerStats.lastHeartbeatAt?.toISOString() ?? null,
        lastMessageAt:   consumerStats.lastMessageAt?.toISOString()   ?? null,
      },
      offsets: consumerStats.offsets,
    };

    // Service is healthy when DB is up.
    // Kafka degraded downgrades to "degraded" — it won't consume new alerts
    // but existing data is still queryable.
    const healthy = dbOk;

    res.status(healthy ? 200 : 503).json({
      status:    healthy ? "ok" : "degraded",
      uptime:    Math.round(process.uptime() * 100) / 100,
      timestamp: new Date().toISOString(),
      checks: {
        database: dbCheck,
        kafka:    kafkaCheck,
      },
    });
  });

  // ── GET /health/live ───────────────────────────────────────────────────────

  router.get("/health/live", (_req: Request, res: Response) => {
    res.status(200).json({ status: "ok" });
  });

  // ── GET /health/ready ──────────────────────────────────────────────────────

  router.get("/health/ready", async (_req: Request, res: Response) => {
    try {
      await ping();
      res.status(200).json({ status: "ok" });
    } catch {
      res.status(503).json({ status: "not_ready", reason: "database_unreachable" });
    }
  });

  return router;
}
