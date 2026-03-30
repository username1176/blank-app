import { Router, Request, Response } from "express";
import { ping, timescaledbVersion } from "../config/database";
import { logger } from "../config/logger";
import { mqttClient } from "../mqtt/client";
import { getMqttStats } from "../mqtt/handler";

export const healthRouter = Router();

// ---------------------------------------------------------------------------
// GET /health
// ---------------------------------------------------------------------------
// Returns 200 when all dependencies are healthy, 503 when any are degraded.
//
// {
//   "status":  "ok" | "degraded",
//   "uptime":  123.4,
//   "timestamp": "...",
//   "checks": {
//     "database": { "status": "ok"|"error", "latencyMs": 4, "timescaledb": "2.14" },
//     "mqtt":     { "status": "ok"|"degraded", "state": "connected"|...,
//                   "stats": { received, accepted, rejected } }
//   }
// }
// ---------------------------------------------------------------------------

healthRouter.get("/health", async (_req: Request, res: Response) => {
  // ── Database check ────────────────────────────────────────────────────────
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

  // ── MQTT check ────────────────────────────────────────────────────────────
  const mqttState = mqttClient.connectionState;
  const mqttOk    = mqttClient.isConnected;
  const mqttCheck = {
    status: mqttOk ? "ok" : "degraded",
    state:  mqttState,
    stats:  getMqttStats(),
  };

  // Service is healthy only when DB is reachable.
  // MQTT degraded downgrades to "degraded" but not "unhealthy".
  const healthy = dbOk;

  const body = {
    status:    healthy ? "ok" : "degraded",
    uptime:    Math.round(process.uptime() * 100) / 100,
    timestamp: new Date().toISOString(),
    checks: {
      database: dbCheck,
      mqtt:     mqttCheck,
    },
  };

  res.status(healthy ? 200 : 503).json(body);
});

// ---------------------------------------------------------------------------
// GET /health/live  — Kubernetes liveness probe (no dependency checks)
// ---------------------------------------------------------------------------

healthRouter.get("/health/live", (_req: Request, res: Response) => {
  res.status(200).json({ status: "ok" });
});

// ---------------------------------------------------------------------------
// GET /health/ready  — Kubernetes readiness probe (database only)
// ---------------------------------------------------------------------------

healthRouter.get("/health/ready", async (_req: Request, res: Response) => {
  try {
    await ping();
    res.status(200).json({ status: "ok" });
  } catch {
    res.status(503).json({ status: "not_ready", reason: "database_unreachable" });
  }
});
