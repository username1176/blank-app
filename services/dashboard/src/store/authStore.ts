/**
 * Authentication state — persisted to localStorage via Zustand's persist middleware.
 *
 * Design decisions:
 *
 *   accessTokenExpiresAt — wall-clock ms when the access token expires.  Stored
 *     so that useTokenRefresh can schedule a proactive refresh after a page reload
 *     without waiting for the first 401.
 *
 *   _hydrated — false until the persist middleware has finished reading from
 *     localStorage.  ProtectedRoute renders a spinner while this is false, which
 *     prevents the login-page flash that would otherwise appear on every page
 *     refresh for authenticated users.  Not persisted (starts false every load).
 *
 *   sessionExpired — set to true when a token refresh attempt fails inside the
 *     Axios interceptor (i.e., the refresh token itself is expired or revoked).
 *     The Login page reads this flag to show a "session expired" notice.  Cleared
 *     on the next successful login via setSession.  Not persisted — stale notices
 *     across page reloads are undesirable.
 *
 *   logout(opts) — accepts an optional { sessionExpired: true } flag so the Axios
 *     interceptor can set both the expiry notice and clear auth state atomically.
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { AuthUser, TokenResponse } from "../types";

// ── State shape ────────────────────────────────────────────────────────────────

interface AuthState {
  accessToken:          string | null;
  /** Unix ms when the access token expires (Date.now() + expires_in * 1000). */
  accessTokenExpiresAt: number | null;
  refreshToken:         string | null;
  user:                 AuthUser | null;
  isAuthenticated:      boolean;
  /** True once persist has finished reading from localStorage. */
  _hydrated:            boolean;
  /** True when a token refresh failed — login page uses this for a notice. */
  sessionExpired:       boolean;

  setSession:          (tokens: TokenResponse, user: AuthUser) => void;
  setAccessToken:      (accessToken: string, expiresIn: number) => void;
  logout:              (opts?: { sessionExpired?: boolean }) => void;
  clearSessionExpired: () => void;
}

// ── Store ──────────────────────────────────────────────────────────────────────

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      accessToken:          null,
      accessTokenExpiresAt: null,
      refreshToken:         null,
      user:                 null,
      isAuthenticated:      false,
      _hydrated:            false,
      sessionExpired:       false,

      setSession: (tokens, user) =>
        set({
          accessToken:          tokens.access_token,
          accessTokenExpiresAt: Date.now() + tokens.expires_in * 1000,
          refreshToken:         tokens.refresh_token,
          user,
          isAuthenticated:      true,
          sessionExpired:       false,   // clear any prior expiry notice
        }),

      setAccessToken: (accessToken, expiresIn) =>
        set({
          accessToken,
          accessTokenExpiresAt: Date.now() + expiresIn * 1000,
        }),

      logout: (opts) =>
        set({
          accessToken:          null,
          accessTokenExpiresAt: null,
          refreshToken:         null,
          user:                 null,
          isAuthenticated:      false,
          sessionExpired:       opts?.sessionExpired ?? false,
        }),

      clearSessionExpired: () => set({ sessionExpired: false }),
    }),
    {
      name: "wmp-auth",

      // Only persist tokens and user identity.
      // _hydrated and sessionExpired are intentionally excluded — they should
      // reset to false on every page load.
      partialize: (state) => ({
        accessToken:          state.accessToken,
        accessTokenExpiresAt: state.accessTokenExpiresAt,
        refreshToken:         state.refreshToken,
        user:                 state.user,
        isAuthenticated:      state.isAuthenticated,
      }),

      // Signal to subscribers (ProtectedRoute) that localStorage has been read
      // and state is ready to trust.  The callback runs after Zustand merges the
      // stored value into the store, so useAuthStore is fully initialised here.
      onRehydrateStorage: () => () => {
        useAuthStore.setState({ _hydrated: true });
      },
    },
  ),
);
