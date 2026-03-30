/**
 * AlertConsumer — wraps KafkaJS to provide a managed consumer lifecycle with:
 *
 *   - State machine (stopped → connecting → running / error)
 *   - Per-partition offset tracking and lag-free heartbeating
 *   - Operational stats (consumed / processed / failed / last heartbeat)
 *   - Graceful stop: waits for the in-progress message to finish before
 *     disconnecting so no partial work is committed
 *   - No-op mode when KAFKA_ENABLED=false — consumer reports as "disabled"
 *     so the rest of the service starts normally in local/test environments
 *
 * Usage:
 *
 *   const consumer = new AlertConsumer(config);
 *   consumer.onMessage(handler);   // register before start()
 *   await consumer.start();        // subscribe + run
 *   ...
 *   await consumer.stop();         // graceful disconnect
 */

import {
  Consumer,
  ConsumerRunConfig,
  EachMessagePayload,
  Kafka,
  KafkaConfig,
  KafkaMessage,
  logLevel,
} from "kafkajs";
import { env } from "../config/env";
import { logger } from "../config/logger";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ConsumerState =
  | "disabled"
  | "stopped"
  | "connecting"
  | "running"
  | "stopping"
  | "error";

export interface ConsumerStats {
  state:             ConsumerState;
  consumed:          number;
  processed:         number;
  failed:            number;
  lastHeartbeatAt:   Date | null;
  lastMessageAt:     Date | null;
  /** Kafka message offsets indexed by "{topic}:{partition}". */
  offsets:           Record<string, string>;
}

export interface AlertConsumerConfig {
  brokers:              string[];
  clientId:             string;
  groupId:              string;
  topic:                string;
  fromBeginning:        boolean;
  sessionTimeoutMs:     number;
  heartbeatIntervalMs:  number;
  maxWaitMs:            number;
}

/**
 * The function signature mirrors KafkaJS's eachMessage callback.
 * Handlers must not throw — errors are caught and counted as failures.
 */
export type MessageHandler = (payload: EachMessagePayload) => Promise<void>;

// ---------------------------------------------------------------------------
// AlertConsumer
// ---------------------------------------------------------------------------

export class AlertConsumer {
  private readonly consumer: Consumer;
  private _state: ConsumerState = "stopped";
  private _handler: MessageHandler | null = null;

  // ── Stats ─────────────────────────────────────────────────────────────────
  private _consumed          = 0;
  private _processed         = 0;
  private _failed            = 0;
  private _lastHeartbeatAt:  Date | null = null;
  private _lastMessageAt:    Date | null = null;
  private _offsets:          Record<string, string> = {};

  constructor(private readonly config: AlertConsumerConfig) {
    const kafkaCfg: KafkaConfig = {
      clientId: config.clientId,
      brokers:  config.brokers,
      logLevel: env.NODE_ENV === "production" ? logLevel.WARN : logLevel.INFO,
      retry: {
        initialRetryTime: 300,
        retries:          10,
        factor:           0.2,
        multiplier:       1.5,
        maxRetryTime:     30_000,
      },
    };

    this.consumer = new Kafka(kafkaCfg).consumer({
      groupId:              config.groupId,
      sessionTimeout:       config.sessionTimeoutMs,
      heartbeatInterval:    config.heartbeatIntervalMs,
      maxWaitTimeInMs:      config.maxWaitMs,
      // Allow the consumer to rejoin automatically after a rebalance.
      allowAutoTopicCreation: false,
    });

    this._bindConsumerEvents();
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /** Register the message handler.  Must be called before start(). */
  onMessage(handler: MessageHandler): void {
    this._handler = handler;
  }

  get state(): ConsumerState { return this._state; }
  get isRunning(): boolean   { return this._state === "running"; }

  get stats(): ConsumerStats {
    return {
      state:           this._state,
      consumed:        this._consumed,
      processed:       this._processed,
      failed:          this._failed,
      lastHeartbeatAt: this._lastHeartbeatAt,
      lastMessageAt:   this._lastMessageAt,
      offsets:         { ...this._offsets },
    };
  }

  /**
   * Connect to Kafka, subscribe to the topic, and begin consuming messages.
   * Safe to call only once; subsequent calls throw if the consumer is not
   * in the stopped state.
   */
  async start(): Promise<void> {
    if (this._state !== "stopped") {
      throw new Error(`Cannot start consumer in state "${this._state}"`);
    }
    if (!this._handler) {
      throw new Error("No message handler registered — call onMessage() first");
    }

    this._setState("connecting");

    try {
      await this.consumer.connect();
      await this.consumer.subscribe({
        topic:         this.config.topic,
        fromBeginning: this.config.fromBeginning,
      });

      const runConfig: ConsumerRunConfig = {
        // Commit offsets automatically after each message is processed.
        autoCommit:              true,
        autoCommitInterval:      5_000,
        autoCommitThreshold:     100,
        // Process messages one at a time within a partition to preserve ordering.
        partitionsConsumedConcurrently: 1,
        eachMessage: async (payload: EachMessagePayload) => {
          await this._dispatch(payload);
        },
      };

      // consumer.run() returns a promise that resolves when the consumer stops.
      // We don't await it here — it runs in the background.
      void this.consumer.run(runConfig).catch((err: unknown) => {
        logger.error("Kafka consumer run loop exited with error", {
          error: err instanceof Error ? err.message : String(err),
        });
        this._setState("error");
      });

      this._setState("running");
      logger.info("Kafka consumer started", {
        topic:  this.config.topic,
        group:  this.config.groupId,
        from:   this.config.fromBeginning ? "beginning" : "latest",
      });
    } catch (err) {
      this._setState("error");
      throw err;
    }
  }

  /**
   * Pause message delivery, commit pending offsets, and disconnect.
   * Safe to call from SIGTERM handlers; awaiting it ensures clean shutdown.
   */
  async stop(): Promise<void> {
    if (this._state === "stopped" || this._state === "disabled") return;
    this._setState("stopping");
    try {
      await this.consumer.disconnect();
      this._setState("stopped");
      logger.info("Kafka consumer stopped");
    } catch (err) {
      logger.error("Error stopping Kafka consumer", {
        error: err instanceof Error ? err.message : String(err),
      });
      this._setState("stopped"); // still transition so shutdown can proceed
    }
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private _setState(next: ConsumerState): void {
    if (this._state !== next) {
      logger.debug("Kafka consumer state change", { from: this._state, to: next });
      this._state = next;
    }
  }

  private async _dispatch(payload: EachMessagePayload): Promise<void> {
    this._consumed++;
    this._lastMessageAt = new Date();

    // Track per-partition offset for health/observability.
    const offsetKey = `${payload.topic}:${payload.partition}`;
    this._offsets[offsetKey] = payload.message.offset;

    // Track heartbeat timestamp (KafkaJS calls heartbeat internally, but we
    // also record the last time a message was dispatched as a proxy).
    this._lastHeartbeatAt = new Date();

    try {
      await this._handler!(payload);
      this._processed++;
    } catch (err) {
      this._failed++;
      // Log but do NOT re-throw — rethrowing causes KafkaJS to crash the run loop.
      logger.error("Kafka message handler threw unexpectedly", {
        topic:     payload.topic,
        partition: payload.partition,
        offset:    payload.message.offset,
        error:     err instanceof Error ? err.message : String(err),
      });
    }
  }

  private _bindConsumerEvents(): void {
    const { CRASH, DISCONNECT, GROUP_JOIN, HEARTBEAT, REBALANCING } =
      this.consumer.events;

    this.consumer.on(HEARTBEAT, () => {
      this._lastHeartbeatAt = new Date();
    });

    this.consumer.on(GROUP_JOIN, ({ payload: p }) => {
      logger.info("Kafka consumer joined group", {
        groupId:    p.groupId,
        memberId:   p.memberId,
        isLeader:   p.isLeader,
      });
      if (this._state === "connecting") this._setState("running");
    });

    this.consumer.on(REBALANCING, () => {
      logger.info("Kafka consumer group rebalancing");
    });

    this.consumer.on(DISCONNECT, () => {
      logger.warn("Kafka consumer disconnected");
      if (this._state === "running") this._setState("stopped");
    });

    this.consumer.on(CRASH, ({ payload: p }) => {
      logger.error("Kafka consumer crashed", {
        error:     p.error?.message,
        groupId:   p.groupId,
        restart:   p.restart,
      });
      this._setState("error");
    });
  }
}

// ---------------------------------------------------------------------------
// No-op consumer — used when KAFKA_ENABLED=false
// ---------------------------------------------------------------------------

/**
 * Implements the same interface as AlertConsumer but does nothing.
 * Allows the HTTP server and health checks to start normally in environments
 * that have no Kafka broker (local dev, unit tests).
 */
export class NoopAlertConsumer {
  readonly state: ConsumerState = "disabled";
  readonly isRunning             = false;

  onMessage(_handler: MessageHandler): void { /* no-op */ }

  get stats(): ConsumerStats {
    return {
      state:           "disabled",
      consumed:        0,
      processed:       0,
      failed:          0,
      lastHeartbeatAt: null,
      lastMessageAt:   null,
      offsets:         {},
    };
  }

  async start(): Promise<void> {
    logger.info("Kafka disabled (KAFKA_ENABLED=false) — using no-op consumer");
  }

  async stop(): Promise<void> { /* no-op */ }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Returns a real or no-op consumer based on KAFKA_ENABLED. */
export function createConsumer(): AlertConsumer | NoopAlertConsumer {
  if (!env.KAFKA_ENABLED) {
    return new NoopAlertConsumer();
  }

  const brokers = env.KAFKA_BROKERS.split(",").map((b: string) => b.trim());

  return new AlertConsumer({
    brokers,
    clientId:            env.KAFKA_CLIENT_ID,
    groupId:             env.KAFKA_GROUP_ID,
    topic:               env.KAFKA_ALERTS_TOPIC,
    fromBeginning:       env.KAFKA_FROM_BEGINNING,
    sessionTimeoutMs:    env.KAFKA_SESSION_TIMEOUT_MS,
    heartbeatIntervalMs: env.KAFKA_HEARTBEAT_INTERVAL_MS,
    maxWaitMs:           env.KAFKA_MAX_WAIT_MS,
  });
}
