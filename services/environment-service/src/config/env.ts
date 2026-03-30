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
