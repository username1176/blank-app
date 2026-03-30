/**
 * Rate limiting middleware factory.
 *
 * Two tiers:
 *
 *   Global   — applied to every route before service-specific limits.
 *              Acts as a hard ceiling against burst floods from a single IP.
 *
 *   Per-service — finer-grained limits that reflect the cost of each backend.
 *               The moisture-service has a lower limit because each request
 *               triggers an ML inference pass.
 *
 * Key generation:
 *   Uses the real client IP from X-Forwarded-For (when app.set('trust proxy')
 *   is configured) so limits apply to the client, not the load balancer.
 *
 * Redis (optional):
 *   Set REDIS_URL to share counters across multiple gateway instances.
 *   Without it, each instance maintains its own in-memory counter — still
 *   effective for single-instance deployments.
 *
 * Error response:
 *   Returns a JSON body instead of the default plain-text response so
 *   clients get a machine-readable error code.
 */

import rateLimit, { RateLimitRequestHandler, Store } from "express-rate-limit";
import { env } from "../config/env";
import { logger } from "../config/logger";

// ── Optional Redis store ───────────────────────────────────────────────────────

let sharedStore: Store | undefined;

export async function initRateLimitStore(): Promise<void> {
  if (!env.REDIS_URL) return;

  try {
    // Dynamic import so the package is optional — install redis + rate-limit-redis
    // only when REDIS_URL is set.
    const { default: RedisStore } = await import("rate-limit-redis" as string);
    const { createClient } = await import("redis" as string);

    const client = createClient({ url: env.REDIS_URL });
    client.on("error", (err: Error) =>
      logger.warn("Redis rate-limit client error — falling back to in-memory", { err }),
    );
    await client.connect();

    sharedStore = new (RedisStore as new (opts: object) => Store)({
      sendCommand: (...args: string[]) =>
        (client as unknown as { sendCommand: (a: string[]) => Promise<unknown> }).sendCommand(args),
      prefix: "rl:gateway:",
    });

    logger.info("Rate limiter using Redis store", { url: env.REDIS_URL });
  } catch (err) {
    logger.warn("Redis store unavailable — using in-memory rate limiter", { err });
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

interface LimiterOptions {
  /** Display name used in log messages and error responses. */
  name:     string;
  max:      number;
  windowMs?: number;
  /** When true, the limiter is skipped for requests that already returned 429. */
  skipOnRateLimit?: boolean;
}

function makeLimiter(opts: LimiterOptions): RateLimitRequestHandler {
  return rateLimit({
    windowMs:       opts.windowMs ?? env.RATE_LIMIT_WINDOW_MS,
    max:            opts.max,
    store:          sharedStore,         // undefined → in-memory
    standardHeaders: "draft-7",          // Return RateLimit-* headers (RFC 9110)
    legacyHeaders:   false,
    keyGenerator: (req) => {
      // req.ip already respects trust-proxy setting
      return req.ip ?? req.socket.remoteAddress ?? "unknown";
    },
    skip: (req) => {
      // Never rate-limit health probes — they must always succeed for
      // load-balancer readiness checks.
      return req.path.startsWith("/health");
    },
    handler: (_req, res) => {
      const windowSec = Math.ceil((opts.windowMs ?? env.RATE_LIMIT_WINDOW_MS) / 1000);
      logger.warn("Rate limit exceeded", { limiter: opts.name, ip: _req.ip });
      res.status(429).json({
        error: {
          code:        "RATE_LIMIT_EXCEEDED",
          message:     `Too many requests — retry after ${windowSec} seconds`,
          retryAfter:  windowSec,
          limiter:     opts.name,
        },
      });
    },
  });
}

// ── Exported limiters ─────────────────────────────────────────────────────────

export const globalLimiter = makeLimiter({
  name: "global",
  max:  env.RATE_LIMIT_GLOBAL_MAX,
});

export const inventoryLimiter = makeLimiter({
  name: "inventory",
  max:  env.RATE_LIMIT_INVENTORY_MAX,
});

export const moistureLimiter = makeLimiter({
  name: "moisture",
  max:  env.RATE_LIMIT_MOISTURE_MAX,
});

export const environmentLimiter = makeLimiter({
  name: "environment",
  max:  env.RATE_LIMIT_ENVIRONMENT_MAX,
});

export const alertsLimiter = makeLimiter({
  name: "alerts",
  max:  env.RATE_LIMIT_ALERTS_MAX,
});
