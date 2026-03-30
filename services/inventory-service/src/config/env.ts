import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  // ── Server ─────────────────────────────────────────────────────────────────
  PORT:    z.coerce.number().int().min(1).max(65535).default(3001),
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
  // Minimum 32 characters recommended for HS256
  JWT_SECRET:   z.string().min(16),
  JWT_AUDIENCE: z.string().optional(),
  JWT_ISSUER:   z.string().optional(),

  // ── Kafka ──────────────────────────────────────────────────────────────────
  // Comma-separated list of broker addresses, e.g. "broker1:9092,broker2:9092"
  KAFKA_BROKERS:       z.string().default("localhost:9092"),
  KAFKA_CLIENT_ID:     z.string().default("inventory-service"),
  KAFKA_ALERTS_TOPIC:  z.string().default("alerts"),
  // Set to "false" to disable Kafka publishing in local/test environments
  KAFKA_ENABLED:       z.string().transform((v) => v !== "false").default("true"),

  // ── Alerting ──────────────────────────────────────────────────────────────
  // How often the drop-detection scheduler runs (ms).  Minimum 5 s.
  ALERT_POLL_INTERVAL_MS: z.coerce.number().int().min(5_000).default(60_000),
  // Default drop threshold when no customer/site config is found (%)
  ALERT_DEFAULT_THRESHOLD_PCT:    z.coerce.number().min(1).max(100).default(15),
  // Default lookback window when no config is found (minutes)
  ALERT_DEFAULT_LOOKBACK_MINUTES: z.coerce.number().int().min(1).default(60),
  // Default cooldown between repeated alerts for the same pile (minutes)
  ALERT_DEFAULT_COOLDOWN_MINUTES: z.coerce.number().int().min(1).default(30),

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
