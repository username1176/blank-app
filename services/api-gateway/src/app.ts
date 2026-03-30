/**
 * Express application factory.
 *
 * Middleware stack (in order):
 *   1. requestId       — assign/forward X-Request-Id
 *   2. requestLogger   — structured HTTP log on response finish
 *   3. helmet          — security headers
 *   4. cors            — CORS preflight + headers
 *   5. globalLimiter   — hard IP-level burst ceiling
 *   6. authenticate    — JWT verification (skips public paths)
 *   7. health routes   — /health, /health/live, /health/ready
 *   8. proxy routes    — /api/inventory, /api/moisture, /api/environment, /api/alerts
 *   9. notFound        — 404 for unmatched routes
 *  10. errorHandler    — 500 for unhandled errors
 */

import express from "express";
import helmet from "helmet";
import { requestId }     from "./middleware/requestId";
import { requestLogger } from "./middleware/requestLogger";
import { corsMiddleware } from "./middleware/cors";
import { globalLimiter } from "./middleware/rateLimiter";
import { authenticate }  from "./middleware/authenticate";
import { notFound, errorHandler } from "./middleware/errorHandler";
import { healthRouter }  from "./routes/health";
import { attachProxyRoutes } from "./proxy/routes";

export function createApp(): express.Application {
  const app = express();

  // Trust the first proxy hop so req.ip reflects the real client address.
  app.set("trust proxy", 1);

  // ── Core middleware ──────────────────────────────────────────────────────────
  app.use(requestId);
  app.use(requestLogger);
  app.use(helmet());
  app.use(corsMiddleware);
  app.use(globalLimiter);
  app.use(authenticate);

  // ── Routes ───────────────────────────────────────────────────────────────────
  app.use(healthRouter());
  attachProxyRoutes(app);

  // ── Error handling ────────────────────────────────────────────────────────────
  app.use(notFound);
  app.use(errorHandler);

  return app;
}
