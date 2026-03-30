/**
 * alert-service entry point.
 *
 * Startup sequence:
 *   1. Validate environment variables (fails fast on bad config).
 *   2. Create the pg connection pool (connects lazily on first query).
 *   3. Instantiate the dependency container (repositories, Kafka consumer).
 *   4. Register the Kafka message handler (before connecting to the broker).
 *   5. Start the Kafka consumer (subscribes + begins receiving messages).
 *   6. Start the HTTP server.
 *
 * Shutdown sequence (SIGTERM / SIGINT):
 *   1. Stop accepting new HTTP connections.
 *   2. Pause the Kafka consumer (stop receiving new messages).
 *   3. Wait for the consumer to finish processing the in-flight message.
 *   4. Close the DB pool.
 *   5. Exit 0 — any uncaught error exits 1.
 */

import { env }        from "./config/env";
import { logger }     from "./config/logger";
import { pool, closePool } from "./config/database";
import { createApp }  from "./app";
import { createConsumer } from "./kafka/consumer";
import { createMessageHandler } from "./kafka/handler";
import { AlertRepository } from "./repositories/alertRepository";

// ---------------------------------------------------------------------------
// Dependency container
// ---------------------------------------------------------------------------

const alertRepo = new AlertRepository(pool);
const consumer  = createConsumer();

// ---------------------------------------------------------------------------
// Kafka setup
// ---------------------------------------------------------------------------

// Register the handler before start() so no messages are missed during the
// window between subscribe() and run() inside start().
consumer.onMessage(createMessageHandler(alertRepo));

consumer.start().catch((err: unknown) => {
  logger.error("Failed to start Kafka consumer", {
    error: err instanceof Error ? err.message : String(err),
  });
  // Non-fatal at startup: the HTTP server still starts so health probes work
  // and operators can observe the degraded state.  The consumer will retry
  // internally per the KafkaJS retry policy.
});

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const app    = createApp({ consumer, alertRepo });
const server = app.listen(env.PORT, () => {
  logger.info("alert-service listening", {
    port:   env.PORT,
    env:    env.NODE_ENV,
    kafka:  env.KAFKA_ENABLED
      ? `${env.KAFKA_BROKERS} (group: ${env.KAFKA_GROUP_ID})`
      : "disabled",
    topic:  env.KAFKA_ALERTS_TOPIC,
  });
});

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

async function shutdown(signal: string): Promise<void> {
  logger.info(`Received ${signal} — shutting down gracefully`);

  // Stop accepting new HTTP requests first so load balancers drain traffic.
  server.close(async () => {
    try {
      await consumer.stop();
      await closePool();
      logger.info("Shutdown complete");
      process.exit(0);
    } catch (err) {
      logger.error("Error during shutdown", {
        error: err instanceof Error ? err.message : String(err),
      });
      process.exit(1);
    }
  });

  // Hard deadline — if graceful shutdown takes more than 15 s, force exit.
  setTimeout(() => {
    logger.error("Graceful shutdown timed out — forcing exit");
    process.exit(1);
  }, 15_000).unref();
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT",  () => void shutdown("SIGINT"));

process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled promise rejection", { reason });
});

process.on("uncaughtException", (err: Error) => {
  logger.error("Uncaught exception", { error: err.message, stack: err.stack });
  process.exit(1);
});
