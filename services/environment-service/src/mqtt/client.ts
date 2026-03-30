/**
 * MqttIngestionClient — singleton MQTT client for the environment-service.
 *
 * Responsibilities
 * ----------------
 * - Connect to the configured broker on startup with automatic reconnection.
 * - Subscribe to the sensor readings wildcard topic after each (re)connect.
 * - Expose a typed message handler registration interface so the rest of the
 *   service does not depend on the mqtt package directly.
 * - Report connection state for the health check endpoint.
 * - Disconnect cleanly on process shutdown.
 *
 * The client intentionally never throws on broker unavailability: it logs the
 * error and relies on the mqtt library's built-in reconnection back-off.  The
 * health check surface the degraded state to operators.
 */

import mqtt, { IClientOptions, MqttClient } from "mqtt";
import { env } from "../config/env";
import { logger } from "../config/logger";
import { subscriptionTopic } from "./topics";

export type MessageHandler = (
  topic: string,
  payload: Buffer,
) => void | Promise<void>;

// ---------------------------------------------------------------------------
// Connection state
// ---------------------------------------------------------------------------

export type ConnectionState =
  | "disconnected"   // not yet started or cleanly stopped
  | "connecting"     // initial connect in progress
  | "connected"      // broker handshake complete, subscribed
  | "reconnecting"   // lost connection, retrying
  | "error";         // irrecoverable error (e.g. auth failure)

// ---------------------------------------------------------------------------
// MqttIngestionClient
// ---------------------------------------------------------------------------

export class MqttIngestionClient {
  private client:   MqttClient | null = null;
  private state:    ConnectionState   = "disconnected";
  private handlers: MessageHandler[]  = [];

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  connect(): void {
    if (this.client !== null) {
      logger.warn("MQTT client: connect() called while already initialised");
      return;
    }

    const options: IClientOptions = {
      clientId:        `${env.MQTT_CLIENT_ID}-${process.pid}`,
      clean:           true,
      reconnectPeriod: env.MQTT_RECONNECT_MS,
      connectTimeout:  10_000,
      keepalive:       60,
      ...(env.MQTT_USERNAME && { username: env.MQTT_USERNAME }),
      ...(env.MQTT_PASSWORD && { password: env.MQTT_PASSWORD }),
    };

    this.state  = "connecting";
    this.client = mqtt.connect(env.MQTT_URL, options);

    this.client.on("connect", () => {
      this.state = "connected";
      logger.info("MQTT client: connected to broker", { url: env.MQTT_URL });
      this._subscribe();
    });

    this.client.on("reconnect", () => {
      this.state = "reconnecting";
      logger.warn("MQTT client: reconnecting…", { url: env.MQTT_URL });
    });

    this.client.on("offline", () => {
      this.state = "reconnecting";
      logger.warn("MQTT client: went offline");
    });

    this.client.on("error", (err: Error) => {
      // Auth failures and protocol errors are logged but not fatal — the mqtt
      // library handles retries.  Mark as error only for non-retryable codes.
      const retryable =
        err.message.includes("ECONNREFUSED") ||
        err.message.includes("ETIMEDOUT")    ||
        err.message.includes("ENOTFOUND");

      if (!retryable) {
        this.state = "error";
        logger.error("MQTT client: irrecoverable error", { error: err.message });
      } else {
        logger.warn("MQTT client: connection error (will retry)", {
          error: err.message,
        });
      }
    });

    this.client.on("message", (topic: string, payload: Buffer) => {
      for (const handler of this.handlers) {
        // Each handler is individually wrapped so one failure does not
        // prevent subsequent handlers from running.
        Promise.resolve(handler(topic, payload)).catch((handlerErr: unknown) => {
          logger.error("MQTT message handler threw", {
            topic,
            error: handlerErr instanceof Error ? handlerErr.message : String(handlerErr),
          });
        });
      }
    });
  }

  async disconnect(): Promise<void> {
    if (this.client === null) return;
    await this.client.endAsync(/* force */ false);
    this.client = null;
    this.state  = "disconnected";
    logger.info("MQTT client: disconnected");
  }

  // ── Handler registration ──────────────────────────────────────────────────

  /** Register a callback invoked for every incoming message. */
  onMessage(handler: MessageHandler): void {
    this.handlers.push(handler);
  }

  // ── Status ────────────────────────────────────────────────────────────────

  get connectionState(): ConnectionState {
    return this.state;
  }

  get isConnected(): boolean {
    return this.state === "connected";
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private _subscribe(): void {
    if (this.client === null) return;

    const topic = subscriptionTopic();
    const qos   = env.MQTT_QOS as 0 | 1 | 2;

    this.client.subscribe(topic, { qos }, (err) => {
      if (err) {
        logger.error("MQTT client: subscribe failed", {
          topic,
          error: err.message,
        });
      } else {
        logger.info("MQTT client: subscribed", { topic, qos });
      }
    });
  }
}

// Module-level singleton — imported by server.ts and the message handler.
export const mqttClient = new MqttIngestionClient();
