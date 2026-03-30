/**
 * Express application factory.
 *
 * All service dependencies (repositories, Kafka consumer) are injected as
 * constructor parameters so the function is fully testable without mocking
 * module-level singletons.
 *
 * Dependency graph:
 *
 *   server.ts
 *     └─ createApp({ alertRepo, consumer })
 *           ├─ healthRouter(consumer)       — GET /health, /health/live, /health/ready
 *           └─ alertsRouter                 — GET /alerts, /alerts/:id
 *                 └─ res.locals.alertRepo   — injected per-request from container
 */

import express, { Application, Request, Response } from "express";
import { requestLogger } from "./middleware/requestLogger";
import { errorHandler } from "./middleware/errorHandler";
import { createHealthRouter } from "./routes/health";
import { alertsRouter } from "./routes/alerts";
import { AlertConsumer, NoopAlertConsumer } from "./kafka/consumer";
import { AlertRepository } from "./repositories/alertRepository";

export interface AppContainer {
  /** Kafka consumer instance — passed to the health router for state checks. */
  consumer:  AlertConsumer | NoopAlertConsumer;
  /** Alert repository — attached to res.locals for route handlers. */
  alertRepo: AlertRepository;
}

export function createApp(container: AppContainer): Application {
  const app = express();

  // ── Attach repository to every request ────────────────────────────────────
  // Handlers access dependencies via res.locals rather than importing singletons.
  // This keeps route handlers pure functions of their inputs.
  app.use((_req, res, next) => {
    res.locals["alertRepo"] = container.alertRepo;
    next();
  });

  // ── Request parsing ───────────────────────────────────────────────────────
  app.use(express.json({ limit: "512kb" }));
  app.use(express.urlencoded({ extended: false }));

  app.disable("x-powered-by");

  // ── Logging ───────────────────────────────────────────────────────────────
  app.use(requestLogger);

  // ── Routes ────────────────────────────────────────────────────────────────
  app.use("/", createHealthRouter(container.consumer));
  app.use("/", alertsRouter);

  // ── 404 catch-all ─────────────────────────────────────────────────────────
  app.use((_req: Request, res: Response) => {
    res.status(404).json({
      error: { code: "NOT_FOUND", message: "Route not found" },
    });
  });

  // ── Error handler (must be last) ──────────────────────────────────────────
  app.use(errorHandler);

  return app;
}
