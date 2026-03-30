import express, { Application, Request, Response } from "express";
import { requestLogger } from "./middleware/requestLogger";
import { errorHandler } from "./middleware/errorHandler";
import { healthRouter } from "./routes/health";

export function createApp(): Application {
  const app = express();

  // ── Request parsing ───────────────────────────────────────────────────────
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));

  // ── Security headers (minimal — add helmet in production) ─────────────────
  app.disable("x-powered-by");

  // ── Logging ───────────────────────────────────────────────────────────────
  app.use(requestLogger);

  // ── Routes ────────────────────────────────────────────────────────────────
  app.use("/", healthRouter);

  // Catch-all for unmatched routes
  app.use((_req: Request, res: Response) => {
    res.status(404).json({
      error: { code: "NOT_FOUND", message: "Route not found" },
    });
  });

  // ── Error handler (must be last) ──────────────────────────────────────────
  app.use(errorHandler);

  return app;
}
