import { env } from "./config/env";
import { logger } from "./config/logger";
import { closePool } from "./config/database";
import { pool } from "./config/database";
import { createApp } from "./app";
import { mqttClient } from "./mqtt/client";
import { createMessageHandler } from "./mqtt/handler";

// ---------------------------------------------------------------------------
// MQTT setup
// ---------------------------------------------------------------------------

if (env.MQTT_ENABLED) {
  // Wire the message handler before connecting so no messages are missed.
  mqttClient.onMessage(createMessageHandler(pool));
  mqttClient.connect();
} else {
  logger.info("MQTT disabled (MQTT_ENABLED=false) — REST-only mode");
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const app    = createApp();
const server = app.listen(env.PORT, () => {
  logger.info("environment-service listening", {
    port: env.PORT,
    env:  env.NODE_ENV,
    mqtt: env.MQTT_ENABLED ? env.MQTT_URL : "disabled",
  });
});

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

async function shutdown(signal: string): Promise<void> {
  logger.info(`Received ${signal} — shutting down gracefully`);

  server.close(async () => {
    try {
      await mqttClient.disconnect();
      await closePool();
      logger.info("Shutdown complete");
      process.exit(0);
    } catch (err) {
      logger.error("Error during shutdown", { error: err });
      process.exit(1);
    }
  });

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
