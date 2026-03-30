/**
 * HTTP server entry point.
 *
 * Start-up sequence:
 *   1. Initialise the optional Redis rate-limit store (no-op if REDIS_URL unset)
 *   2. Create the Express application
 *   3. Start the HTTP server
 *
 * Graceful shutdown:
 *   On SIGTERM / SIGINT the server stops accepting new connections and waits
 *   for in-flight requests to drain before exiting.  The drain timeout is
 *   hard-coded to 10 s — long enough for slow upstreams but short enough to
 *   respect most orchestrator deadlines.
 */

import { createApp }           from "./app";
import { initRateLimitStore }  from "./middleware/rateLimiter";
import { env }                 from "./config/env";
import { logger }              from "./config/logger";

const DRAIN_TIMEOUT_MS = 10_000;

async function main(): Promise<void> {
  // 1. Optional Redis store for distributed rate limiting.
  await initRateLimitStore();

  // 2. Build Express app.
  const app = createApp();

  // 3. Start HTTP server.
  const server = app.listen(env.PORT, () => {
    logger.info("api-gateway listening", { port: env.PORT, env: env.NODE_ENV });
  });

  // ── Graceful shutdown ────────────────────────────────────────────────────────

  let shuttingDown = false;

  function shutdown(signal: string): void {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info("Shutdown signal received — draining connections", { signal });

    // Stop accepting new connections.
    server.close((err) => {
      if (err) {
        logger.error("Error during server close", { err });
        process.exit(1);
      }
      logger.info("Server closed cleanly");
      process.exit(0);
    });

    // Force-exit if drain takes too long.
    setTimeout(() => {
      logger.warn("Drain timeout exceeded — forcing exit");
      process.exit(1);
    }, DRAIN_TIMEOUT_MS).unref();
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT",  () => shutdown("SIGINT"));

  process.on("uncaughtException", (err) => {
    logger.error("Uncaught exception", { err });
    process.exit(1);
  });

  process.on("unhandledRejection", (reason) => {
    logger.error("Unhandled promise rejection", { reason });
    process.exit(1);
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Fatal startup error:", err);
  process.exit(1);
});
