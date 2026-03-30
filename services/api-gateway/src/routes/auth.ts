/**
 * Authentication routes.
 *
 *   POST /auth/login    — validate credentials against the upstream auth service,
 *                         return access + refresh token pair.
 *   POST /auth/refresh  — exchange a valid (non-revoked) refresh token for a
 *                         new token pair (rotation: old refresh token is revoked).
 *   POST /auth/logout   — revoke a refresh token.  Idempotent; returns 204
 *                         regardless of whether the token was already revoked.
 *
 * Token shape (both endpoints return the same structure):
 *   {
 *     access_token:  "<jwt>",
 *     refresh_token: "<jwt>",
 *     token_type:    "Bearer",
 *     expires_in:    <seconds>   // access token lifetime only
 *   }
 *
 * Login flow:
 *   The gateway forwards credentials to AUTH_SERVICE_URL/authenticate.
 *   On success the auth service responds with identity claims; the gateway
 *   mints both tokens locally and never forwards the raw password upstream.
 *
 * Refresh flow:
 *   1. Verify refresh token signature + expiry.
 *   2. Check jti not revoked.
 *   3. Revoke old jti (one-time-use enforcement).
 *   4. Issue new access + refresh tokens.
 *
 * Logout flow:
 *   Verify refresh token signature (accepting expired tokens — still revoke
 *   the jti as belt-and-suspenders).  Invalid signatures are silently ignored
 *   to avoid leaking information about valid jtis.
 */

import { Router, Request, Response } from "express";
import { z }   from "zod";
import jwt     from "jsonwebtoken";
import { v4 as uuidv4 } from "uuid";
import {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  parseTtlSeconds,
  type RefreshTokenPayload,
} from "../auth/tokens";
import { tokenStore } from "../auth/tokenStore";
import { env }    from "../config/env";
import { logger } from "../config/logger";

// ── Zod schemas ────────────────────────────────────────────────────────────────

const loginBodySchema = z.object({
  email:    z.string().email(),
  password: z.string().min(1),
});

const refreshBodySchema = z.object({
  refresh_token: z.string().min(1),
});

const logoutBodySchema = z.object({
  refresh_token: z.string().min(1).optional(),
});

/** Shape of a successful response from AUTH_SERVICE_URL/authenticate */
const authServiceResponseSchema = z.object({
  userId:     z.string().min(1),
  customerId: z.string().min(1),
  siteIds:    z.array(z.string()).default([]),
  email:      z.string().email().nullable().optional(),
});

type AuthServiceResponse = z.infer<typeof authServiceResponseSchema>;

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Build and return a full access + refresh token pair. */
function issueTokenPair(user: AuthServiceResponse): Record<string, unknown> {
  const jti = uuidv4();

  const access_token = signAccessToken({
    sub:         user.userId,
    customer_id: user.customerId,
    site_ids:    user.siteIds,
    email:       user.email ?? null,
  });

  const refresh_token = signRefreshToken({
    sub:         user.userId,
    customer_id: user.customerId,
    site_ids:    user.siteIds,
    email:       user.email ?? null,
    jti,
  });

  return {
    access_token,
    refresh_token,
    token_type: "Bearer",
    expires_in: parseTtlSeconds(env.JWT_ACCESS_TTL),
  };
}

/** Try to decode a refresh token, accepting expired ones (for logout). */
function decodeSilent(token: string): RefreshTokenPayload | null {
  try {
    return verifyRefreshToken(token);
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      // Still decode so we can revoke the jti.
      const decoded = jwt.decode(token) as RefreshTokenPayload | null;
      if (decoded?.type === "refresh" && decoded.jti) return decoded;
    }
    return null; // Invalid signature or malformed — nothing to revoke
  }
}

// ── Router ─────────────────────────────────────────────────────────────────────

export function authRouter(): Router {
  const router = Router();

  // ── POST /auth/login ─────────────────────────────────────────────────────────

  router.post("/login", async (req: Request, res: Response): Promise<void> => {
    const parsed = loginBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: { code: "VALIDATION_ERROR", details: parsed.error.flatten() },
      });
      return;
    }

    const { email, password } = parsed.data;

    // ── Call upstream auth service ─────────────────────────────────────────────
    let user: AuthServiceResponse;
    try {
      const response = await fetch(`${env.AUTH_SERVICE_URL}/authenticate`, {
        method:  "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Request-Id": String(res.locals["requestId"] ?? ""),
        },
        body:   JSON.stringify({ email, password }),
        signal: AbortSignal.timeout(10_000),
      });

      if (response.status === 401 || response.status === 403) {
        logger.info("Login rejected by auth service", { email });
        res.status(401).json({
          error: { code: "INVALID_CREDENTIALS", message: "Email or password is incorrect" },
        });
        return;
      }

      if (!response.ok) {
        logger.error("Auth service returned unexpected status", { status: response.status });
        res.status(502).json({
          error: { code: "AUTH_SERVICE_ERROR", message: "Authentication service error" },
        });
        return;
      }

      const body    = await response.json();
      const checked = authServiceResponseSchema.safeParse(body);
      if (!checked.success) {
        logger.error("Auth service response shape invalid", { issues: checked.error.issues });
        res.status(502).json({
          error: { code: "AUTH_SERVICE_ERROR", message: "Authentication service returned unexpected data" },
        });
        return;
      }
      user = checked.data;
    } catch (err) {
      const isTimeout = err instanceof Error && err.name === "TimeoutError";
      logger.error(isTimeout ? "Auth service timed out" : "Auth service unreachable", { err });
      res.status(502).json({
        error: {
          code:    isTimeout ? "AUTH_SERVICE_TIMEOUT" : "AUTH_SERVICE_UNAVAILABLE",
          message: "Authentication service is temporarily unavailable",
        },
      });
      return;
    }

    logger.info("Login successful", { customerId: user.customerId, userId: user.userId });
    res.status(200).json(issueTokenPair(user));
  });

  // ── POST /auth/refresh ───────────────────────────────────────────────────────

  router.post("/refresh", (req: Request, res: Response): void => {
    const parsed = refreshBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: { code: "VALIDATION_ERROR", details: parsed.error.flatten() },
      });
      return;
    }

    const { refresh_token } = parsed.data;

    // ── Verify signature and expiry ────────────────────────────────────────────
    let payload: RefreshTokenPayload;
    try {
      payload = verifyRefreshToken(refresh_token);
    } catch (err) {
      const isExpired = err instanceof jwt.TokenExpiredError;
      res.status(401).json({
        error: {
          code:    isExpired ? "REFRESH_TOKEN_EXPIRED" : "INVALID_REFRESH_TOKEN",
          message: isExpired
            ? "Refresh token has expired — please log in again"
            : "Refresh token is invalid",
        },
      });
      return;
    }

    // ── Check revocation ───────────────────────────────────────────────────────
    if (tokenStore.isRevoked(payload.jti)) {
      logger.warn("Attempted reuse of revoked refresh token", {
        jti:        payload.jti,
        customerId: payload.customer_id,
        userId:     payload.sub,
      });
      res.status(401).json({
        error: {
          code:    "REFRESH_TOKEN_REVOKED",
          message: "Refresh token has already been used — please log in again",
        },
      });
      return;
    }

    // ── Rotate: revoke old jti, issue new pair ─────────────────────────────────
    const expMs = (payload.exp) * 1000;
    tokenStore.revoke(payload.jti, new Date(expMs));

    const user: AuthServiceResponse = {
      userId:     payload.sub,
      customerId: payload.customer_id,
      siteIds:    payload.site_ids,
      email:      payload.email,
    };

    res.status(200).json(issueTokenPair(user));
  });

  // ── POST /auth/logout ────────────────────────────────────────────────────────

  router.post("/logout", (req: Request, res: Response): void => {
    const parsed = logoutBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: { code: "VALIDATION_ERROR", details: parsed.error.flatten() },
      });
      return;
    }

    const { refresh_token } = parsed.data;

    if (refresh_token) {
      // Accept expired tokens so users can clean up stale sessions.
      const payload = decodeSilent(refresh_token);
      if (payload) {
        const expMs = payload.exp * 1000;
        tokenStore.revoke(payload.jti, new Date(expMs));
        logger.info("Refresh token revoked on logout", {
          customerId: payload.customer_id,
          userId:     payload.sub,
          jti:        payload.jti,
        });
      }
    }

    res.status(204).send();
  });

  return router;
}
