import { env } from "./config/env";
import { logger } from "./config/logger";
import { pool, closePool } from "./config/database";
import { createApp } from "./app";
import { AlertConfigRepository } from "./alerting/alertConfigRepository";
import { InventorySnapshotRepository } from "./repositories/inventorySnapshotRepository";
import { createAlertProducer } from "./alerting/kafkaProducer";
import { DropDetector } from "./alerting/dropDetector";
import { AlertScheduler } from "./alerting/scheduler";

// ---------------------------------------------------------------------------
// Alerting subsystem
// ---------------------------------------------------------------------------

const alertConfigRepo = new AlertConfigRepository(pool);
const snapshotRepo    = new InventorySnapshotRepository(pool);
const alertProducer   = createAlertProducer();
const dropDetector    = new DropDetector(snapshotRepo, alertConfigRepo, alertProducer);
const alertScheduler  = new AlertScheduler(alertConfigRepo, dropDetector);

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const app    = createApp();
const server = app.listen(env.PORT, () => {
  logger.info(`inventory-service listening`, {
    port: env.PORT,
    env:  env.NODE_ENV,
  });
});

// Connect Kafka then start the scheduler once the server is up
alertProducer.connect()
  .then(() => { alertScheduler.start(); })
  .catch((err: unknown) => {
    logger.error("Failed to connect Kafka producer — alerting disabled", {
      error: (err as Error).message,
    });
  });

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

async function shutdown(signal: string): Promise<void> {
  logger.info(`Received ${signal} — shutting down gracefully`);

  // Stop accepting new connections
  server.close(async () => {
    try {
      await alertScheduler.stop();
      await alertProducer.disconnect();
      await closePool();
      logger.info("Shutdown complete");
      process.exit(0);
    } catch (err) {
      logger.error("Error during shutdown", { error: err });
      process.exit(1);
    }
  });

  // Force exit if graceful shutdown takes too long
  setTimeout(() => {
    logger.error("Graceful shutdown timed out — forcing exit");
    process.exit(1);
  }, 10_000).unref();
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT",  () => void shutdown("SIGINT"));

process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled promise rejection", { reason });
});

process.on("uncaughtException", (err) => {
  logger.error("Uncaught exception", { error: err.message, stack: err.stack });
  process.exit(1);
});
