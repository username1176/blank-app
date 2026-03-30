import express, { Application, Request, Response } from "express";
import { pool } from "./config/database";
import { requestLogger } from "./middleware/requestLogger";
import { errorHandler } from "./middleware/errorHandler";
import { healthRouter } from "./routes/health";
import { sensorsRouter } from "./routes/sensors";
import { AnomalyDetector } from "./anomaly/detector";
import { AnomalyRepository } from "./repositories/anomalyRepository";
import { SensorReadingRepository } from "./repositories/sensorReadingRepository";

// Stateless repositories — single instance per process is correct.
const sensorRepo = new SensorReadingRepository(pool);

export function createApp(
  anomalyDetector: AnomalyDetector    | null = null,
  anomalyRepo:     AnomalyRepository  | null = null,
): Application {
  const app = express();

  // ── Attach repositories / services to every request ───────────────────────
  app.use((_req, res, next) => {
    res.locals["sensorRepo"]      = sensorRepo;
    res.locals["anomalyRepo"]     = anomalyRepo;
    res.locals["anomalyDetector"] = anomalyDetector;
    next();
  });

  // ── Request parsing ───────────────────────────────────────────────────────
  app.use(express.json({ limit: "2mb" }));
  app.use(express.urlencoded({ extended: false }));

  app.disable("x-powered-by");

  // ── Logging ───────────────────────────────────────────────────────────────
  app.use(requestLogger);

  // ── Routes ────────────────────────────────────────────────────────────────
  app.use("/", healthRouter);
  app.use("/", sensorsRouter);

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
