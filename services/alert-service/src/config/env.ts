import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  // ── Server ─────────────────────────────────────────────────────────────────
  PORT:     z.coerce.number().int().min(1).max(65535).default(3004),
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

  // ── Kafka consumer ─────────────────────────────────────────────────────────
  // Comma-separated broker addresses
  KAFKA_BROKERS:               z.string().default("localhost:9092"),
  KAFKA_CLIENT_ID:             z.string().default("alert-service"),
  KAFKA_GROUP_ID:              z.string().default("alert-service-group"),
  KAFKA_ALERTS_TOPIC:          z.string().default("alerts"),
  // Set to "false" to use a no-op consumer (broker-free local dev)
  KAFKA_ENABLED:               z.string().transform((v) => v !== "false").default("true"),
  // true = read from earliest offset; false = start from latest
  KAFKA_FROM_BEGINNING:        z.string().transform((v) => v === "true").default("false"),
  KAFKA_SESSION_TIMEOUT_MS:    z.coerce.number().int().min(1000).default(30_000),
  KAFKA_HEARTBEAT_INTERVAL_MS: z.coerce.number().int().min(100).default(3_000),
  KAFKA_MAX_WAIT_MS:           z.coerce.number().int().min(0).default(500),

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
