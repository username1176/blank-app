/**
 * useTokenRefresh — proactive access-token refresh scheduler.
 *
 * Mounts in AppLayout (inside every authenticated page) and handles two cases:
 *
 *   1. Scheduled refresh — sets a setTimeout to fire REFRESH_BEFORE_MS (2 min)
 *      before the access token expires.  Re-schedules whenever accessTokenExpiresAt
 *      changes (i.e., after every successful refresh).
 *
 *   2. Focus refresh — when the browser tab regains focus and fewer than
 *      FOCUS_THRESHOLD_MS (5 min) remain on the current token, triggers an
 *      immediate refresh.  Covers the case where a user leaves the tab open for
 *      hours and returns to find a nearly-expired token.
 *
 * Error handling:
 *   Proactive refresh failures are silently swallowed.  The Axios response
 *   interceptor in api/client.ts handles reactive 401s — we don't want to log
 *   the user out just because a background refresh hit a transient network error.
 *   If the token genuinely expires, the next API call will trigger a reactive
 *   refresh; if that also fails, the interceptor calls logout({ sessionExpired }).
 *
 * Refresh transport:
 *   Uses a plain axios instance (not the instrumented apiClient) to avoid
 *   triggering the 401 interceptor for the refresh call itself.
 */

import { useEffect, useCallback } from "react";
import axios                       from "axios";
import { useAuthStore }            from "../store/authStore";

const BASE_URL = import.meta.env.VITE_API_URL ?? "";

/** Refresh the access token this many ms before it expires. */
const REFRESH_BEFORE_MS = 2 * 60 * 1000;   // 2 minutes

/** Re-fetch on window focus if fewer than this many ms remain. */
const FOCUS_THRESHOLD_MS = 5 * 60 * 1000;  // 5 minutes

export function useTokenRefresh(): void {
  const accessTokenExpiresAt = useAuthStore((s) => s.accessTokenExpiresAt);
  const refreshToken         = useAuthStore((s) => s.refreshToken);
  const setAccessToken       = useAuthStore((s) => s.setAccessToken);

  // Stable refresh function — recreated only when refreshToken changes.
  const doRefresh = useCallback(async (): Promise<void> => {
    if (!refreshToken) return;
    try {
      const { data } = await axios.post<{ access_token: string; expires_in: number }>(
        `${BASE_URL}/auth/refresh`,
        { refresh_token: refreshToken },
        { timeout: 10_000 },
      );
      setAccessToken(data.access_token, data.expires_in);
    } catch {
      // Swallow proactive failures — the reactive interceptor handles real expiry.
    }
  }, [refreshToken, setAccessToken]);

  // ── Scheduled refresh ───────────────────────────────────────────────────────
  useEffect(() => {
    if (!accessTokenExpiresAt || !refreshToken) return;

    const msUntilRefresh = accessTokenExpiresAt - Date.now() - REFRESH_BEFORE_MS;

    if (msUntilRefresh <= 0) {
      // Already within the refresh window — fire immediately.
      void doRefresh();
      return;
    }

    const timer = window.setTimeout(() => void doRefresh(), msUntilRefresh);
    return () => window.clearTimeout(timer);
  }, [accessTokenExpiresAt, refreshToken, doRefresh]);

  // ── Focus refresh ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (!refreshToken) return;

    const handleFocus = (): void => {
      const exp = useAuthStore.getState().accessTokenExpiresAt;
      if (!exp) return;
      const remaining = exp - Date.now();
      if (remaining < FOCUS_THRESHOLD_MS) {
        void doRefresh();
      }
    };

    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, [refreshToken, doRefresh]);
}
