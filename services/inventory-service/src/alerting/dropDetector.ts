import { randomUUID } from "crypto";
import { logger } from "../config/logger";
import { env } from "../config/env";
import { InventorySnapshotRepository } from "../repositories/inventorySnapshotRepository";
import { AlertConfigRepository } from "./alertConfigRepository";
import { IAlertProducer } from "./kafkaProducer";
import { AlertEvent, PileDescriptor, ResolvedAlertConfig } from "./types";

// ---------------------------------------------------------------------------
// DropDetector
// ---------------------------------------------------------------------------

/**
 * Orchestrates a single drop-detection check for one pile.
 *
 * Flow:
 *   1. Resolve the most specific alert config (pile > site > customer default).
 *   2. Check the cooldown window — skip if a recent alert already fired.
 *   3. Run the DB-side drop detection query.
 *   4. If a drop is detected: publish to Kafka, persist to alert_logs.
 */
export class DropDetector {
  constructor(
    private readonly snapshotRepo:    InventorySnapshotRepository,
    private readonly alertConfigRepo: AlertConfigRepository,
    private readonly producer:        IAlertProducer,
  ) {}

  async checkPile(pile: PileDescriptor): Promise<boolean> {
    const { pileId, pileName, siteId, customerId } = pile;

    // ── 1. Resolve config ────────────────────────────────────────────────────
    const config = await this.resolveConfig(customerId, siteId, pileId);

    // ── 2. Cooldown guard ────────────────────────────────────────────────────
    const coolingDown = await this.alertConfigRepo.isCoolingDown(
      customerId,
      pileId,
      config.cooldownMinutes,
    );

    if (coolingDown) {
      logger.debug("Pile still in cooldown — skipping", { pileId, customerId });
      return false;
    }

    // ── 3. Drop detection ────────────────────────────────────────────────────
    const drop = await this.snapshotRepo.detectSuddenDrop(
      customerId,
      pileId,
      config.dropThresholdPct,
      config.lookbackMinutes,
    );

    if (!drop) return false;

    // ── 4. Publish + persist ─────────────────────────────────────────────────
    const event = this.buildEvent(pile, config, drop);

    try {
      await this.producer.publish(event);
    } catch (err) {
      // Publishing failure must not suppress the alert_log insert — we still
      // want the cooldown to activate so the next tick doesn't re-fire.
      logger.error("Failed to publish alert to Kafka", {
        alertId: event.id,
        pileId,
        error: (err as Error).message,
      });
    }

    await this.alertConfigRepo.insertAlertLog({
      customerId,
      siteId,
      pileId,
      configId: config.configId,
      severity: config.severity,
      message:  event.message,
      details:  event.details as unknown as Record<string, unknown>,
    });

    logger.info("Inventory drop alert fired", {
      alertId:   event.id,
      pileId,
      pileName,
      customerId,
      dropPct:   drop.dropPct,
      severity:  config.severity,
    });

    return true;
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private async resolveConfig(
    customerId: string,
    siteId: string,
    pileId: string,
  ): Promise<ResolvedAlertConfig> {
    const config = await this.alertConfigRepo.resolveForPile(customerId, siteId, pileId);

    if (config) return config;

    // Fall back to process-level defaults from env
    return {
      configId:         "default",
      dropThresholdPct: env.ALERT_DEFAULT_THRESHOLD_PCT,
      lookbackMinutes:  env.ALERT_DEFAULT_LOOKBACK_MINUTES,
      cooldownMinutes:  env.ALERT_DEFAULT_COOLDOWN_MINUTES,
      severity:         "warning",
    };
  }

  private buildEvent(
    pile:   PileDescriptor,
    config: ResolvedAlertConfig,
    drop: {
      currentVolumeM3:   number;
      referenceVolumeM3: number;
      dropPct:           number;
      detectedAt:        Date;
    },
  ): AlertEvent {
    return {
      id:         randomUUID(),
      type:       "inventory_drop",
      severity:   config.severity,
      customerId: pile.customerId,
      siteId:     pile.siteId,
      pileId:     pile.pileId,
      pileName:   pile.pileName,
      message: `Pile "${pile.pileName}" volume dropped ${drop.dropPct.toFixed(1)}%` +
               ` (threshold: ${config.dropThresholdPct}%)`,
      details: {
        currentVolumeM3:   drop.currentVolumeM3,
        referenceVolumeM3: drop.referenceVolumeM3,
        dropPct:           drop.dropPct,
        thresholdPct:      config.dropThresholdPct,
        lookbackMinutes:   config.lookbackMinutes,
        detectedAt:        drop.detectedAt.toISOString(),
      },
      createdAt: new Date().toISOString(),
    };
  }
}
