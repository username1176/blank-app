/**
 * Authentication state — persisted to localStorage.
 *
 * Tokens are stored here and attached to every API request by the axios
 * interceptor in api/client.ts.  The store is the single source of truth
 * for "is the user logged in?" — components should not inspect tokens directly.
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { AuthUser, TokenResponse } from "../types";

interface AuthState {
  accessToken:  string | null;
  refreshToken: string | null;
  user:         AuthUser | null;
  isAuthenticated: boolean;

  /** Called after a successful login or token refresh. */
  setSession: (tokens: TokenResponse, user: AuthUser) => void;
  /** Called after a successful token refresh (user claims unchanged). */
  setAccessToken: (accessToken: string, expiresIn: number) => void;
  logout: () => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      accessToken:     null,
      refreshToken:    null,
      user:            null,
      isAuthenticated: false,

      setSession: (tokens, user) =>
        set({
          accessToken:     tokens.access_token,
          refreshToken:    tokens.refresh_token,
          user,
          isAuthenticated: true,
        }),

      setAccessToken: (accessToken) =>
        set({ accessToken }),

      logout: () =>
        set({
          accessToken:     null,
          refreshToken:    null,
          user:            null,
          isAuthenticated: false,
        }),
    }),
    {
      name:    "wmp-auth",
      // Only persist the tokens and user — not derived flags.
      partialize: (state) => ({
        accessToken:     state.accessToken,
        refreshToken:    state.refreshToken,
        user:            state.user,
        isAuthenticated: state.isAuthenticated,
      }),
    },
  ),
);
