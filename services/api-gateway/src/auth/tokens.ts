/**
 * JWT token signing and verification.
 *
 * Two distinct token types are issued:
 *
 *   Access token  — short-lived (default 15 m); carries full tenant context
 *                   (customer_id, site_ids, email) so upstream services can
 *                   scope queries without a second lookup.  Signed with JWT_SECRET.
 *
 *   Refresh token — longer-lived (default 7 d); carries only identity claims
 *                   + a jti (JWT ID) for per-token revocation.  Signed with
 *                   JWT_REFRESH_SECRET so the secrets can be rotated independently.
 *
 * Token type discrimination:
 *   Every token carries a `type` claim.  The authenticate middleware rejects
 *   refresh tokens presented as access credentials.  Legacy tokens (issued by
 *   upstream services without a `type` claim) are accepted for backwards
 *   compatibility.
 */

import jwt from "jsonwebtoken";
import { env } from "../config/env";

// ── Token payload types ────────────────────────────────────────────────────────

export interface AccessTokenPayload {
  sub:         string;        // userId
  customer_id: string;
  site_ids:    string[];
  email:       string | null;
  type:        "access";
  iat:         number;
  exp:         number;
}

export interface RefreshTokenPayload {
  sub:         string;        // userId
  customer_id: string;
  site_ids:    string[];
  email:       string | null;
  jti:         string;        // unique ID for per-token revocation
  type:        "refresh";
  iat:         number;
  exp:         number;
}

// ── Sign ───────────────────────────────────────────────────────────────────────

type AccessTokenInput  = Pick<AccessTokenPayload,  "sub" | "customer_id" | "site_ids" | "email">;
type RefreshTokenInput = Pick<RefreshTokenPayload, "sub" | "customer_id" | "site_ids" | "email" | "jti">;

export function signAccessToken(claims: AccessTokenInput): string {
  return jwt.sign(
    { ...claims, type: "access" },
    env.JWT_SECRET,
    { expiresIn: env.JWT_ACCESS_TTL as jwt.SignOptions["expiresIn"], algorithm: "HS256" },
  );
}

export function signRefreshToken(claims: RefreshTokenInput): string {
  return jwt.sign(
    { ...claims, type: "refresh" },
    env.JWT_REFRESH_SECRET,
    { expiresIn: env.JWT_REFRESH_TTL as jwt.SignOptions["expiresIn"], algorithm: "HS256" },
  );
}

// ── Verify ─────────────────────────────────────────────────────────────────────

/**
 * Verifies an access token.
 * Accepts tokens with `type: "access"` (issued by this gateway) and legacy
 * tokens without a `type` claim (issued by upstream identity services).
 * Rejects tokens with `type: "refresh"` to prevent cross-type misuse.
 */
export function verifyAccessToken(token: string): AccessTokenPayload {
  const payload = jwt.verify(token, env.JWT_SECRET) as AccessTokenPayload;
  if (payload.type !== undefined && payload.type !== "access") {
    throw new jwt.JsonWebTokenError("expected access token, got refresh token");
  }
  return payload;
}

export function verifyRefreshToken(token: string): RefreshTokenPayload {
  const payload = jwt.verify(token, env.JWT_REFRESH_SECRET) as RefreshTokenPayload;
  if (payload.type !== "refresh") {
    throw new jwt.JsonWebTokenError("expected refresh token");
  }
  return payload;
}

// ── TTL helpers ────────────────────────────────────────────────────────────────

/**
 * Parses a JWT duration string ("15m", "7d", "1h", "3600s") into seconds.
 * Falls back to 900 (15 m) for unrecognised formats.
 */
export function parseTtlSeconds(ttl: string): number {
  const match = /^(\d+)([smhd])$/i.exec(ttl);
  if (!match || !match[1] || !match[2]) return 900;
  const value = parseInt(match[1], 10);
  const unit  = match[2].toLowerCase();
  const multipliers: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86_400 };
  return value * (multipliers[unit] ?? 1);
}
