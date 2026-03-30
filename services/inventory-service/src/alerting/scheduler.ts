import { logger } from "../config/logger";
import { env } from "../config/env";
import { AlertConfigRepository } from "./alertConfigRepository";
import { DropDetector } from "./dropDetector";

// ---------------------------------------------------------------------------
// AlertScheduler
// ---------------------------------------------------------------------------

/**
 * Runs the drop-detection loop on a fixed interval.
 *
 * Design notes:
 * - Uses `setInterval` rather than recursive `setTimeout` to keep timing
 *   consistent, but an overlap guard prevents concurrent ticks from piling up
 *   if the DB is slow.
 * - start() connects the Kafka producer; stop() drains in-flight work and
 *   disconnects it cleanly.
 */
export class AlertScheduler {
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly alertConfigRepo: AlertConfigRepository,
    private readonly detector:        DropDetector,
  ) {}

  start(): void {
    if (this.intervalHandle !== null) {
      logger.warn("AlertScheduler.start() called while already running — ignoring");
      return;
    }

    logger.info("AlertScheduler starting", {
      pollIntervalMs: env.ALERT_POLL_INTERVAL_MS,
    });

    this.intervalHandle = setInterval(() => {
      void this.tick();
    }, env.ALERT_POLL_INTERVAL_MS);

    // Run one tick immediately so alerts aren't delayed by a full interval on startup
    void this.tick();
  }

  async stop(): Promise<void> {
    if (this.intervalHandle === null) return;

    clearInterval(this.intervalHandle);
    this.intervalHandle = null;

    // Wait for any in-flight tick to finish (poll up to 5 s)
    const deadline = Date.now() + 5_000;
    while (this.running && Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }

    if (this.running) {
      logger.warn("AlertScheduler: timed out waiting for in-flight tick to complete");
    }

    logger.info("AlertScheduler stopped");
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  private async tick(): Promise<void> {
    if (this.running) {
      logger.debug("AlertScheduler tick skipped — previous tick still running");
      return;
    }

    this.running = true;
    const tickStart = Date.now();

    try {
      await this.runDetection();
    } catch (err) {
      logger.error("AlertScheduler tick failed with unexpected error", {
        error: (err as Error).message,
        stack: (err as Error).stack,
      });
    } finally {
      this.running = false;
      logger.debug("AlertScheduler tick complete", {
        durationMs: Date.now() - tickStart,
      });
    }
  }

  private async runDetection(): Promise<void> {
    const piles = await this.alertConfigRepo.findActivePiles();

    if (piles.length === 0) {
      logger.debug("No active piles found — nothing to check");
      return;
    }

    logger.debug("Running drop detection", { pileCount: piles.length });

    // Check piles in parallel but cap concurrency at 10 to avoid overwhelming the pool
    const CONCURRENCY = 10;

    for (let i = 0; i < piles.length; i += CONCURRENCY) {
      const batch = piles.slice(i, i + CONCURRENCY);

      const results = await Promise.allSettled(
        batch.map((pile) => this.detector.checkPile(pile)),
      );

      for (let j = 0; j < results.length; j++) {
        const result = results[j];
        const pile   = batch[j];

        if (result?.status === "rejected") {
          logger.error("Drop detection failed for pile", {
            pileId:     pile?.pileId,
            customerId: pile?.customerId,
            error:      (result.reason as Error).message,
          });
        }
      }
    }
  }
}
