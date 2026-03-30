/**
 * Express application factory.
 *
 * Middleware stack (in order):
 *   1.  requestId       — assign/forward X-Request-Id
 *   2.  requestLogger   — structured HTTP log on response finish
 *   3.  helmet          — security headers
 *   4.  cors            — CORS preflight + headers
 *   5.  globalLimiter   — hard IP-level burst ceiling
 *   6.  /auth routes    — login, refresh, logout (public; own body parser + rate limiter)
 *   7.  authenticate    — JWT verification (skips paths in JWT_PUBLIC_PATHS)
 *   8.  health routes   — /health, /health/live, /health/ready
 *   9.  proxy routes    — /api/inventory, /api/moisture, /api/environment, /api/alerts
 *  10.  notFound        — 404 for unmatched routes
 *  11.  errorHandler    — 500 for unhandled errors
 *
 * Body parsing:
 *   express.json() is scoped to /auth only.  Proxy routes must NOT have
 *   a body parser applied — consuming the body here would break POST/PUT
 *   forwarding to upstream services.
 */

import express from "express";
import helmet from "helmet";
import { requestId }     from "./middleware/requestId";
import { requestLogger } from "./middleware/requestLogger";
import { corsMiddleware } from "./middleware/cors";
import { globalLimiter, authLimiter } from "./middleware/rateLimiter";
import { authenticate }  from "./middleware/authenticate";
import { notFound, errorHandler } from "./middleware/errorHandler";
import { healthRouter }  from "./routes/health";
import { authRouter }    from "./routes/auth";
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

  // ── Auth routes (public — no JWT required) ───────────────────────────────────
  // Body parser is scoped here so it never intercepts the proxy routes below.
  app.use(
    "/auth",
    express.json({ limit: "10kb" }),
    authLimiter,
    authRouter(),
  );

  // ── Authenticate all remaining routes ────────────────────────────────────────
  app.use(authenticate);

  // ── Routes ───────────────────────────────────────────────────────────────────
  app.use(healthRouter());
  attachProxyRoutes(app);

  // ── Error handling ────────────────────────────────────────────────────────────
  app.use(notFound);
  app.use(errorHandler);

  return app;
}
