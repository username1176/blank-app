/**
 * JWT authentication middleware.
 *
 * When JWT_VERIFY_AT_GATEWAY=true (the default) every request to a
 * non-public path must carry a valid Bearer token.  On success the decoded
 * claims are stored in res.locals.auth and the canonical identity headers
 * (X-Customer-Id, X-User-Id) are injected into req.headers so they are
 * forwarded to upstream services by http-proxy-middleware.
 *
 * To prevent spoofing, any identity headers supplied by the client are
 * stripped before the proxy step regardless of whether auth is enabled.
 *
 * Public paths:
 *   Configured via JWT_PUBLIC_PATHS (comma-separated).  A request path is
 *   considered public when it starts with any of the configured prefixes.
 *   This is checked AFTER stripping the identity headers so even public
 *   routes cannot inject spoofed headers.
 */

import { RequestHandler } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env";
import { logger } from "../config/logger";

// ── Types ──────────────────────────────────────────────────────────────────────

interface JwtPayload {
  sub?:         string;
  customerId?:  string;
  customer_id?: string;
  userId?:      string;
  user_id?:     string;
  email?:       string | null;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function isPublicPath(path: string): boolean {
  return env.JWT_PUBLIC_PATHS.some((prefix) => path.startsWith(prefix));
}

function extractBearer(authHeader: string | undefined): string | null {
  if (!authHeader || !authHeader.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7).trim();
  return token.length > 0 ? token : null;
}

// ── Middleware ─────────────────────────────────────────────────────────────────

export const authenticate: RequestHandler = (req, res, next): void => {
  // Always strip client-supplied identity headers to prevent spoofing.
  delete req.headers["x-customer-id"];
  delete req.headers["x-user-id"];

  if (!env.JWT_VERIFY_AT_GATEWAY || isPublicPath(req.path)) {
    return next();
  }

  const token = extractBearer(req.headers.authorization);

  if (!token) {
    res.status(401).json({
      error: {
        code:    "UNAUTHORIZED",
        message: "Missing or malformed Authorization header",
      },
    });
    return;
  }

  try {
    const payload = jwt.verify(token, env.JWT_SECRET) as JwtPayload;

    const customerId = payload.customerId ?? payload.customer_id ?? "";
    const userId     = payload.userId ?? payload.user_id ?? payload.sub ?? "";
    const email      = payload.email ?? null;

    if (!customerId || !userId) {
      logger.warn("JWT missing customerId or userId claims", { path: req.path });
      res.status(401).json({
        error: {
          code:    "UNAUTHORIZED",
          message: "Token is missing required claims",
        },
      });
      return;
    }

    // Store for request logging and route handlers.
    res.locals["auth"] = { customerId, userId, email };

    // Forward identity to upstream services.
    req.headers["x-customer-id"] = customerId;
    req.headers["x-user-id"]     = userId;

    next();
  } catch (err) {
    const isExpired = err instanceof jwt.TokenExpiredError;
    logger.debug("JWT verification failed", { err, path: req.path });
    res.status(401).json({
      error: {
        code:    isExpired ? "TOKEN_EXPIRED" : "INVALID_TOKEN",
        message: isExpired ? "Token has expired" : "Token is invalid",
      },
    });
  }
};
