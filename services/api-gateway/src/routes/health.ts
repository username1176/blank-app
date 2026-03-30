/**
 * Gateway health endpoints.
 *
 *   GET /health/live   — liveness probe; always 200 if the process is running.
 *   GET /health/ready  — readiness probe; 200 only when all upstreams are reachable.
 *   GET /health        — full status; includes per-service upstream health.
 *
 * Upstream checks use a short timeout (3 s) so a slow service doesn't block
 * the load balancer's readiness check for too long.
 *
 * The /health/* paths are excluded from rate limiting and authentication by
 * the rate limiter and authenticate middleware respectively.
 */

import { Router, Request, Response } from "express";
import http from "http";
import https from "https";
import { env } from "../config/env";
import { logger } from "../config/logger";

const HEALTH_TIMEOUT_MS = 3_000;

interface UpstreamStatus {
  name:    string;
  url:     string;
  healthy: boolean;
  latencyMs?: number;
  error?:     string;
}

// ── Upstream probe ─────────────────────────────────────────────────────────────

async function probeUpstream(name: string, baseUrl: string): Promise<UpstreamStatus> {
  const url = `${baseUrl.replace(/\/$/, "")}/health/live`;
  const start = Date.now();

  return new Promise((resolve) => {
    const client = url.startsWith("https") ? https : http;

    const req = client.get(url, { timeout: HEALTH_TIMEOUT_MS }, (res) => {
      // Drain the response body so the socket can be reused.
      res.resume();
      const latencyMs = Date.now() - start;
      const healthy   = res.statusCode !== undefined && res.statusCode < 500;
      resolve({ name, url, healthy, latencyMs });
    });

    req.on("error", (err: Error) => {
      resolve({ name, url, healthy: false, error: err.message });
    });

    req.on("timeout", () => {
      req.destroy();
      resolve({ name, url, healthy: false, error: "timeout" });
    });
  });
}

// ── Router ─────────────────────────────────────────────────────────────────────

export function healthRouter(): Router {
  const router = Router();

  /** Liveness — is the gateway process alive? */
  router.get("/health/live", (_req: Request, res: Response): void => {
    res.status(200).json({ status: "ok" });
  });

  /** Readiness — can the gateway reach all upstreams? */
  router.get("/health/ready", async (_req: Request, res: Response): Promise<void> => {
    const results = await Promise.all([
      probeUpstream("inventory",   env.INVENTORY_SERVICE_URL),
      probeUpstream("moisture",    env.MOISTURE_SERVICE_URL),
      probeUpstream("environment", env.ENVIRONMENT_SERVICE_URL),
      probeUpstream("alerts",      env.ALERT_SERVICE_URL),
    ]);

    const allHealthy = results.every((r) => r.healthy);

    if (!allHealthy) {
      const down = results.filter((r) => !r.healthy).map((r) => r.name);
      logger.warn("Readiness check: upstream(s) unhealthy", { down });
    }

    res.status(allHealthy ? 200 : 503).json({
      status:    allHealthy ? "ready" : "degraded",
      upstreams: results,
    });
  });

  /** Full health — gateway metadata + upstream status. */
  router.get("/health", async (_req: Request, res: Response): Promise<void> => {
    const results = await Promise.all([
      probeUpstream("inventory",   env.INVENTORY_SERVICE_URL),
      probeUpstream("moisture",    env.MOISTURE_SERVICE_URL),
      probeUpstream("environment", env.ENVIRONMENT_SERVICE_URL),
      probeUpstream("alerts",      env.ALERT_SERVICE_URL),
    ]);

    const allHealthy = results.every((r) => r.healthy);

    res.status(allHealthy ? 200 : 207).json({
      status:    allHealthy ? "healthy" : "degraded",
      version:   process.env["npm_package_version"] ?? "unknown",
      uptime:    Math.floor(process.uptime()),
      upstreams: results,
    });
  });

  return router;
}
