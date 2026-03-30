import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  // Server
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  // Database
  DB_HOST: z.string().min(1).default("localhost"),
  DB_PORT: z.coerce.number().int().min(1).max(65535).default(5432),
  DB_NAME: z.string().min(1),
  DB_USER: z.string().min(1),
  DB_PASSWORD: z.string().min(1),
  DB_POOL_MIN: z.coerce.number().int().min(0).default(2),
  DB_POOL_MAX: z.coerce.number().int().min(1).default(10),
  DB_IDLE_TIMEOUT_MS: z.coerce.number().int().min(0).default(30_000),
  DB_CONNECTION_TIMEOUT_MS: z.coerce.number().int().min(0).default(5_000),

  // Logging
  LOG_LEVEL: z
    .enum(["error", "warn", "info", "http", "debug"])
    .default("info"),
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
