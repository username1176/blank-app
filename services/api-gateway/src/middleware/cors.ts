/**
 * CORS configuration.
 *
 * CORS_ORIGINS accepts:
 *   "*"                          — allow any origin (development / public APIs)
 *   "https://app.example.com"    — single origin
 *   "https://a.com,https://b.com" — comma-separated list of trusted origins
 *
 * CORS_ALLOW_CREDENTIALS must be false when CORS_ORIGINS is "*", otherwise
 * browsers reject the response.  The factory enforces this constraint.
 *
 * Exposed headers:
 *   X-Request-Id — so clients can log the gateway-assigned request ID.
 *   X-RateLimit-* — so clients can see their remaining quota.
 */

import cors, { CorsOptions } from "cors";
import { env } from "../config/env";

function parsedOrigins(): string[] | "*" {
  const raw = env.CORS_ORIGINS.trim();
  if (raw === "*") return "*";
  return raw.split(",").map((o) => o.trim()).filter(Boolean);
}

const origins = parsedOrigins();

// Enforce: credentials + wildcard is invalid per the CORS spec.
if (env.CORS_ALLOW_CREDENTIALS && origins === "*") {
  // eslint-disable-next-line no-console
  console.warn(
    "[api-gateway] CORS_ALLOW_CREDENTIALS=true is incompatible with " +
      "CORS_ORIGINS=* — credentials will be disabled.",
  );
}

const corsOptions: CorsOptions = {
  origin:
    origins === "*"
      ? "*"
      : (origin, callback) => {
          if (!origin || (origins as string[]).includes(origin)) {
            callback(null, true);
          } else {
            callback(new Error(`Origin ${origin} is not allowed by CORS policy`));
          }
        },
  credentials:     env.CORS_ALLOW_CREDENTIALS && origins !== "*",
  methods:         ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"],
  allowedHeaders:  [
    "Content-Type",
    "Authorization",
    "X-Request-Id",
    "X-Correlation-Id",
    "X-API-Key",
  ],
  exposedHeaders: ["X-Request-Id", "X-RateLimit-Limit", "X-RateLimit-Remaining", "X-RateLimit-Reset"],
  maxAge:          86_400, // cache preflight for 24 h
};

export const corsMiddleware = cors(corsOptions);
