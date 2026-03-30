/**
 * HTTP request logger middleware.
 *
 * Logs one structured line per response containing:
 *   method, path, status, latency_ms, upstream (derived from the URL),
 *   request_id, customer_id (if authenticated), remote IP, user-agent.
 *
 * Timing uses process.hrtime.bigint() for sub-millisecond precision.
 * The bigint is stored on res.locals.startAt so it survives async hops.
 *
 * Health-check probes (GET /health/*) are logged at DEBUG level to keep
 * production logs clean — they typically account for the majority of traffic.
 */

import { RequestHandler } from "express";
import { logger } from "../config/logger";

const HEALTH_RE = /^\/health(?:\/|$)/;

export const requestLogger: RequestHandler = (req, res, next): void => {
  res.locals["startAt"] = process.hrtime.bigint();

  res.on("finish", () => {
    const startAt = res.locals["startAt"] as bigint | undefined;
    const latencyMs = startAt
      ? Number(process.hrtime.bigint() - startAt) / 1e6
      : -1;

    const entry = {
      method:     req.method,
      path:       req.path,
      query:      Object.keys(req.query).length ? req.query : undefined,
      status:     res.statusCode,
      latencyMs:  Math.round(latencyMs * 100) / 100,
      upstream:   _upstream(req.path),
      requestId:  res.locals["requestId"],
      customerId: res.locals["auth"]?.customerId,
      ip:         _clientIp(req),
      userAgent:  req.headers["user-agent"],
      contentLength: res.getHeader("content-length"),
    };

    const isHealthProbe = HEALTH_RE.test(req.path);
    if (isHealthProbe) {
      logger.debug(entry);
    } else {
      logger.http(entry);
    }
  });

  next();
};

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Infer the upstream service name from the request path. */
function _upstream(path: string): string | undefined {
  const m = path.match(/^\/api\/([^/]+)/);
  return m?.[1];
}

/** Resolve the real client IP, respecting X-Forwarded-For when behind a proxy. */
function _clientIp(req: import("express").Request): string {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string") {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.ip ?? req.socket.remoteAddress ?? "unknown";
}
