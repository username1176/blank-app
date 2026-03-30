import { Request, Response, NextFunction } from "express";
import { logger } from "../config/logger";

/**
 * HTTP request/response logger.
 * Logs method, path, status code, and response time for every request.
 * Skips noisy health-check traffic in production.
 */
export function requestLogger(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const startedAt = Date.now();

  res.on("finish", () => {
    const durationMs = Date.now() - startedAt;
    const isHealthCheck = req.path === "/health";

    if (isHealthCheck && process.env["NODE_ENV"] === "production") {
      return; // suppress in prod to avoid log noise
    }

    const level = res.statusCode >= 500 ? "error"
      : res.statusCode >= 400 ? "warn"
      : "http";

    logger.log(level, `${req.method} ${req.path}`, {
      method:     req.method,
      path:       req.path,
      statusCode: res.statusCode,
      durationMs,
      ip:         req.ip,
      userAgent:  req.get("user-agent"),
    });
  });

  next();
}
