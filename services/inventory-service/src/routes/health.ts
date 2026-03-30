import { Router, Request, Response } from "express";
import { ping, timescaledbVersion } from "../config/database";
import { logger } from "../config/logger";

export const healthRouter = Router();

// ---------------------------------------------------------------------------
// GET /health
// ---------------------------------------------------------------------------
// Returns HTTP 200 when the service and its dependencies are healthy,
// HTTP 503 when any required dependency is unreachable.
//
// Response shape:
// {
//   "status":  "ok" | "degraded",
//   "uptime":  123.45,                 // process uptime in seconds
//   "timestamp": "2025-01-01T00:00:00Z",
//   "checks": {
//     "database": {
//       "status":      "ok" | "error",
//       "latencyMs":   4,
//       "timescaledb": "2.14.2"        // null when TimescaleDB is not installed
//     }
//   }
// }
// ---------------------------------------------------------------------------

interface DatabaseCheck {
  status:      "ok" | "error";
  latencyMs?:  number;
  timescaledb: string | null;
  error?:      string;
}

interface HealthBody {
  status:    "ok" | "degraded";
  uptime:    number;
  timestamp: string;
  checks: {
    database: DatabaseCheck;
  };
}

healthRouter.get("/health", async (_req: Request, res: Response) => {
  let dbCheck: DatabaseCheck;

  try {
    const [latencyMs, tsdbVersion] = await Promise.all([
      ping(),
      timescaledbVersion(),
    ]);

    dbCheck = {
      status:      "ok",
      latencyMs,
      timescaledb: tsdbVersion,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn("Health check: database unreachable", { error: message });

    dbCheck = {
      status:      "error",
      timescaledb: null,
      error:       message,
    };
  }

  const healthy = dbCheck.status === "ok";

  const body: HealthBody = {
    status:    healthy ? "ok" : "degraded",
    uptime:    Math.round(process.uptime() * 100) / 100,
    timestamp: new Date().toISOString(),
    checks: {
      database: dbCheck,
    },
  };

  res.status(healthy ? 200 : 503).json(body);
});

// ---------------------------------------------------------------------------
// GET /health/live
// ---------------------------------------------------------------------------
// Lightweight liveness probe for Kubernetes — does not check dependencies.
// Returns 200 as long as the Node process is running.
// ---------------------------------------------------------------------------

healthRouter.get("/health/live", (_req: Request, res: Response) => {
  res.status(200).json({ status: "ok" });
});

// ---------------------------------------------------------------------------
// GET /health/ready
// ---------------------------------------------------------------------------
// Readiness probe — same as /health but semantically signals that the service
// is ready to receive traffic (load balancer / k8s readiness gate).
// ---------------------------------------------------------------------------

healthRouter.get("/health/ready", async (_req: Request, res: Response) => {
  try {
    await ping();
    res.status(200).json({ status: "ok" });
  } catch {
    res.status(503).json({ status: "not_ready", reason: "database_unreachable" });
  }
});
