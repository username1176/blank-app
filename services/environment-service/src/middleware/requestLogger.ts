import { Request, Response, NextFunction } from "express";
import { logger } from "../config/logger";
import { env } from "../config/env";

export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const start = Date.now();
  res.on("finish", () => {
    // Suppress /health noise in production
    if (env.NODE_ENV === "production" && req.path.startsWith("/health")) return;
    logger.http("request", {
      method:     req.method,
      path:       req.path,
      status:     res.statusCode,
      durationMs: Date.now() - start,
    });
  });
  next();
}
