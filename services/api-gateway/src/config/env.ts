import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  // ── Server ──────────────────────────────────────────────────────────────────
  PORT:     z.coerce.number().int().min(1).max(65535).default(3000),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  // ── Logging ─────────────────────────────────────────────────────────────────
  LOG_LEVEL: z.enum(["error", "warn", "info", "http", "debug"]).default("info"),

  // ── CORS ────────────────────────────────────────────────────────────────────
  CORS_ORIGINS:            z.string().default("*"),
  CORS_ALLOW_CREDENTIALS:  z
    .string()
    .toLowerCase()
    .transform((v) => v === "true")
    .default("false"),

  // ── JWT authentication ───────────────────────────────────────────────────────
  // Signing secret for access tokens (shared with upstream services).
  JWT_SECRET:           z.string().min(16, "JWT_SECRET must be at least 16 characters"),
  // Separate secret for refresh tokens — can be rotated independently.
  JWT_REFRESH_SECRET:   z.string().min(16, "JWT_REFRESH_SECRET must be at least 16 characters"),
  JWT_VERIFY_AT_GATEWAY: z
    .string()
    .toLowerCase()
    .transform((v) => v !== "false")
    .default("true"),
  // Standard JWT duration strings, e.g. "15m", "1h", "7d".
  JWT_ACCESS_TTL:  z.string().default("15m"),
  JWT_REFRESH_TTL: z.string().default("7d"),
  // Comma-separated path prefixes that bypass JWT verification.
  // /auth/login and /auth/refresh are always public; /health/* for probes.
  JWT_PUBLIC_PATHS: z
    .string()
    .default("/health,/auth/login,/auth/refresh")
    .transform((v) => v.split(",").map((p) => p.trim()).filter(Boolean)),

  // ── Upstream auth service ────────────────────────────────────────────────────
  // The gateway delegates credential validation to this service.
  // It must expose POST /authenticate → { userId, customerId, siteIds, email }.
  AUTH_SERVICE_URL: z.string().url().default("http://auth-service:3005"),

  // ── Upstream services ────────────────────────────────────────────────────────
  INVENTORY_SERVICE_URL:   z.string().url().default("http://inventory-service:3001"),
  MOISTURE_SERVICE_URL:    z.string().url().default("http://moisture-service:3002"),
  ENVIRONMENT_SERVICE_URL: z.string().url().default("http://environment-service:3003"),
  ALERT_SERVICE_URL:       z.string().url().default("http://alert-service:3004"),

  // ── Proxy ────────────────────────────────────────────────────────────────────
  PROXY_TIMEOUT_MS: z.coerce.number().int().min(1000).default(30_000),

  // ── Rate limiting ─────────────────────────────────────────────────────────────
  REDIS_URL:                z.string().url().optional().or(z.literal("").transform(() => undefined)),
  RATE_LIMIT_WINDOW_MS:     z.coerce.number().int().min(1_000).default(60_000),
  RATE_LIMIT_GLOBAL_MAX:    z.coerce.number().int().min(1).default(600),
  RATE_LIMIT_INVENTORY_MAX: z.coerce.number().int().min(1).default(200),
  RATE_LIMIT_MOISTURE_MAX:  z.coerce.number().int().min(1).default(60),
  RATE_LIMIT_ENVIRONMENT_MAX: z.coerce.number().int().min(1).default(300),
  RATE_LIMIT_ALERTS_MAX:    z.coerce.number().int().min(1).default(200),
  // Auth endpoints are brute-force vectors — use a tighter window.
  RATE_LIMIT_AUTH_MAX:       z.coerce.number().int().min(1).default(20),
  RATE_LIMIT_AUTH_WINDOW_MS: z.coerce.number().int().min(1_000).default(900_000), // 15 min
});

const result = schema.safeParse(process.env);

if (!result.success) {
  const formatted = result.error.issues
    .map((i) => `  ${i.path.join(".")}: ${i.message}`)
    .join("\n");
  // eslint-disable-next-line no-console
  console.error(`api-gateway: invalid environment configuration:\n${formatted}`);
  process.exit(1);
}

export const env = result.data;
