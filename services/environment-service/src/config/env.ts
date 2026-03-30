import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  // ── Server ─────────────────────────────────────────────────────────────────
  PORT:     z.coerce.number().int().min(1).max(65535).default(3003),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  // ── PostgreSQL / TimescaleDB ───────────────────────────────────────────────
  DB_HOST:                  z.string().min(1).default("localhost"),
  DB_PORT:                  z.coerce.number().int().min(1).max(65535).default(5432),
  DB_NAME:                  z.string().min(1),
  DB_USER:                  z.string().min(1),
  DB_PASSWORD:              z.string().min(1),
  DB_POOL_MIN:              z.coerce.number().int().min(0).default(2),
  DB_POOL_MAX:              z.coerce.number().int().min(1).default(10),
  DB_IDLE_TIMEOUT_MS:       z.coerce.number().int().min(0).default(30_000),
  DB_CONNECTION_TIMEOUT_MS: z.coerce.number().int().min(0).default(5_000),

  // ── JWT ────────────────────────────────────────────────────────────────────
  JWT_SECRET:   z.string().min(16),
  JWT_AUDIENCE: z.string().optional(),
  JWT_ISSUER:   z.string().optional(),

  // ── MQTT ──────────────────────────────────────────────────────────────────
  // Full broker URL including scheme, e.g. mqtt://broker:1883 or mqtts://...
  MQTT_URL:           z.string().url(),
  MQTT_CLIENT_ID:     z.string().default("environment-service"),
  MQTT_USERNAME:      z.string().optional(),
  MQTT_PASSWORD:      z.string().optional(),
  // QoS level for subscriptions (0 | 1 | 2)
  MQTT_QOS:           z.coerce.number().int().min(0).max(2).default(1),
  MQTT_RECONNECT_MS:  z.coerce.number().int().min(100).default(5_000),
  MQTT_ENABLED:       z.string().transform((v) => v !== "false").default("true"),
  // Topic root: full pattern is {prefix}/{customerId}/site/{siteId}/sensor/{sensorId}/readings
  MQTT_TOPIC_PREFIX:  z.string().default("warehouse"),

  // ── Kafka ─────────────────────────────────────────────────────────────────
  // Comma-separated broker addresses, e.g. "broker1:9092,broker2:9092"
  KAFKA_BROKERS:      z.string().default("localhost:9092"),
  KAFKA_CLIENT_ID:    z.string().default("environment-service"),
  KAFKA_ALERTS_TOPIC: z.string().default("alerts"),
  // Set to "false" to skip Kafka and use the no-op producer
  KAFKA_ENABLED:      z.string().transform((v) => v !== "false").default("true"),

  // ── Anomaly detection ─────────────────────────────────────────────────────
  // Set to "false" to disable anomaly detection without touching Kafka config
  ANOMALY_ENABLED:               z.string().transform((v) => v !== "false").default("true"),
  // Hours of sensor history used to compute the rolling baseline
  ANOMALY_BASELINE_WINDOW_HOURS: z.coerce.number().int().min(1).default(24),
  // Minimum number of readings in the window before detection is active
  ANOMALY_MIN_READINGS:          z.coerce.number().int().min(2).default(10),
  // Standard deviations from baseline mean that trigger a warning alert
  ANOMALY_WARNING_SIGMA:         z.coerce.number().min(0.5).default(2.0),
  // Standard deviations from baseline mean that trigger a critical alert
  ANOMALY_CRITICAL_SIGMA:        z.coerce.number().min(0.5).default(3.0),
  // Minutes before the same sensor/metric/severity combination can re-alert
  ANOMALY_COOLDOWN_MINUTES:      z.coerce.number().int().min(1).default(30),

  // ── Logging ────────────────────────────────────────────────────────────────
  LOG_LEVEL: z.enum(["error", "warn", "info", "http", "debug"]).default("info"),
});

const result = envSchema.safeParse(process.env);

if (!result.success) {
  console.error(
    "❌  Invalid environment variables:\n",
    result.error.flatten().fieldErrors,
  );
  process.exit(1);
}

export const env = result.data;
