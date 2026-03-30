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
import { env }               from "../config/env";
import { logger }            from "../config/logger";
import { verifyAccessToken } from "../auth/tokens";

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
  // Strip client-supplied identity headers first — always, before any auth
  // check — so even public paths cannot inject spoofed tenant context.
  delete req.headers["x-customer-id"];
  delete req.headers["x-user-id"];
  delete req.headers["x-site-ids"];

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
    const payload = verifyAccessToken(token);

    // Normalise claim names: gateway-issued tokens use customer_id / site_ids;
    // legacy upstream tokens may use camelCase variants.
    const legacyPayload = payload as unknown as Record<string, unknown>;
    const customerId =
      payload.customer_id ||
      (legacyPayload["customerId"] as string | undefined) || "";
    const userId =
      payload.sub ||
      (legacyPayload["userId"] as string | undefined) ||
      (legacyPayload["user_id"] as string | undefined) || "";
    const siteIds: string[] =
      Array.isArray(payload.site_ids) ? payload.site_ids : [];
    const email = payload.email ?? null;

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

    // Store for request logging and downstream route handlers.
    res.locals["auth"] = { customerId, userId, siteIds, email };

    // Inject verified tenant context so upstream services can trust these headers
    // without re-verifying the JWT themselves.
    req.headers["x-customer-id"] = customerId;
    req.headers["x-user-id"]     = userId;
    if (siteIds.length > 0) {
      req.headers["x-site-ids"] = siteIds.join(",");
    }

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
