import express, { Application, Request, Response } from "express";
import { pool } from "./config/database";
import { requestLogger } from "./middleware/requestLogger";
import { errorHandler } from "./middleware/errorHandler";
import { healthRouter } from "./routes/health";
import { pilesRouter } from "./routes/piles";
import { inventoryRouter } from "./routes/inventory";
import { PileRepository } from "./repositories/pileRepository";
import { InventorySnapshotRepository } from "./repositories/inventorySnapshotRepository";

// Repositories are stateless (they hold only a pool reference) so a single
// instance per process is correct and avoids unnecessary allocations.
const pileRepo     = new PileRepository(pool);
const snapshotRepo = new InventorySnapshotRepository(pool);

// Attach to res.locals so every route handler can access them without
// importing the pool directly.
export function createApp(): Application {
  const app = express();

  app.use((_req, res, next) => {
    res.locals["pileRepo"]     = pileRepo;
    res.locals["snapshotRepo"] = snapshotRepo;
    next();
  });

  // ── Request parsing ───────────────────────────────────────────────────────
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));

  // ── Security headers (minimal — add helmet in production) ─────────────────
  app.disable("x-powered-by");

  // ── Logging ───────────────────────────────────────────────────────────────
  app.use(requestLogger);

  // ── Routes ────────────────────────────────────────────────────────────────
  app.use("/", healthRouter);
  app.use("/", pilesRouter);
  app.use("/", inventoryRouter);

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
