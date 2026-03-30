/**
 * useAuth — primary hook for all authentication actions.
 *
 * Consolidates the auth store + API calls so components import a single hook
 * instead of wiring store selectors and API functions independently.
 *
 * login(email, password):
 *   Calls POST /auth/login, decodes the returned access token to extract
 *   identity claims, and writes the session to the store.  Throws on failure
 *   so the caller can display an appropriate error message.
 *
 * logout(redirectTo?):
 *   Revokes the refresh token via POST /auth/logout, clears the store, and
 *   navigates to redirectTo (default "/login").  The API call is best-effort:
 *   the session is always cleared even if the network request fails.
 *
 * Token decoding:
 *   decodeAccessToken reads identity claims (sub, customer_id, site_ids, email)
 *   from the JWT payload without verifying the signature.  The gateway already
 *   verified the token; this is purely a client-side claim extraction to avoid
 *   a separate /me round-trip.
 *
 * Error handling:
 *   login() maps Axios HTTP status codes to human-readable messages so callers
 *   never need to inspect error shapes directly.
 */

import { useCallback }     from "react";
import { useNavigate }     from "react-router-dom";
import axios               from "axios";
import { useAuthStore }    from "../store/authStore";
import { login as apiLogin, logout as apiLogout } from "../api/auth";
import type { AuthUser }   from "../types";

// ── JWT claim extraction ───────────────────────────────────────────────────────

/**
 * Decode identity claims from an access token payload.
 * Returns null if the token is malformed — callers should treat that as a
 * server error and surface it to the user.
 */
export function decodeAccessToken(token: string): AuthUser | null {
  try {
    const segment = token.split(".")[1];
    if (!segment) return null;

    // atob requires standard base64; JWT uses URL-safe base64 without padding.
    const padded  = segment.replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(atob(padded)) as Record<string, unknown>;

    const userId     = String(payload["sub"]         ?? "");
    const customerId = String(payload["customer_id"] ?? "");
    const email      = typeof payload["email"] === "string" ? payload["email"] : null;
    const siteIds    = Array.isArray(payload["site_ids"])
      ? (payload["site_ids"] as unknown[]).map(String)
      : [];

    if (!userId || !customerId) return null;

    return { userId, customerId, email, siteIds };
  } catch {
    return null;
  }
}

// ── Error message mapping ──────────────────────────────────────────────────────

function loginErrorMessage(err: unknown): string {
  if (axios.isAxiosError(err)) {
    const status = err.response?.status;
    if (status === 401 || status === 403) {
      return "Email or password is incorrect.";
    }
    if (status === 429) {
      return "Too many login attempts — please wait a few minutes and try again.";
    }
    if (status === 502 || status === 503 || status === 504) {
      return "Authentication service is temporarily unavailable. Please try again shortly.";
    }
    if (!err.response) {
      return "Could not reach the server — check your network connection.";
    }
  }
  return err instanceof Error ? err.message : "Login failed — please try again.";
}

// ── Hook ───────────────────────────────────────────────────────────────────────

export function useAuth() {
  const navigate    = useNavigate();

  const user            = useAuthStore((s) => s.user);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const sessionExpired  = useAuthStore((s) => s.sessionExpired);
  const refreshToken    = useAuthStore((s) => s.refreshToken);

  const setSession          = useAuthStore((s) => s.setSession);
  const logoutStore         = useAuthStore((s) => s.logout);
  const clearSessionExpired = useAuthStore((s) => s.clearSessionExpired);

  /**
   * Authenticate with email + password.
   * On success, writes the session to the store.
   * On failure, throws with a human-readable message string.
   */
  const login = useCallback(
    async (email: string, password: string): Promise<void> => {
      let tokens;
      try {
        tokens = await apiLogin({ email, password });
      } catch (err) {
        throw new Error(loginErrorMessage(err));
      }

      const user = decodeAccessToken(tokens.access_token);
      if (!user) {
        throw new Error("Received an invalid token from the server.");
      }

      setSession(tokens, user);
    },
    [setSession],
  );

  /**
   * Sign out.  Revokes the refresh token server-side (best effort) then
   * clears local state and navigates to the login page.
   */
  const logout = useCallback(
    async (redirectTo = "/login"): Promise<void> => {
      try {
        if (refreshToken) await apiLogout(refreshToken);
      } finally {
        logoutStore();
        navigate(redirectTo, { replace: true });
      }
    },
    [refreshToken, logoutStore, navigate],
  );

  return {
    user,
    isAuthenticated,
    sessionExpired,
    clearSessionExpired,
    login,
    logout,
  };
}
