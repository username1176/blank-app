/**
 * Axios instance for all API calls.
 *
 * Request interceptor  — attaches the Bearer access token from the auth store.
 * Response interceptor — on 401, attempts a single token refresh then retries
 *                        the original request.  If the refresh itself fails,
 *                        the user is logged out.
 *
 * Concurrent refresh:
 *   A pending-queue pattern ensures that if multiple requests fail with 401
 *   simultaneously, only one refresh call is made.  All others are held and
 *   resolved/rejected once the refresh completes.
 */

import axios, { type AxiosRequestConfig } from "axios";
import { useAuthStore } from "../store/authStore";

const BASE_URL = (import.meta.env["VITE_API_URL"] as string | undefined) ?? "";

export const apiClient = axios.create({
  baseURL: BASE_URL,
  timeout: 30_000,
  headers: { "Content-Type": "application/json" },
});

// ── Token refresh queue ────────────────────────────────────────────────────────

let isRefreshing = false;
let pendingQueue: Array<{ resolve: (t: string) => void; reject: (e: unknown) => void }> = [];

function drainQueue(error: unknown, token: string | null = null): void {
  pendingQueue.forEach(({ resolve, reject }) => {
    if (error) reject(error);
    else       resolve(token!);
  });
  pendingQueue = [];
}

// ── Request interceptor ────────────────────────────────────────────────────────

apiClient.interceptors.request.use((config) => {
  const token = useAuthStore.getState().accessToken;
  if (token) {
    config.headers = config.headers ?? {};
    config.headers["Authorization"] = `Bearer ${token}`;
  }
  return config;
});

// ── Response interceptor ───────────────────────────────────────────────────────

apiClient.interceptors.response.use(
  (response) => response,
  async (error: unknown) => {
    if (!axios.isAxiosError(error)) return Promise.reject(error);

    const originalRequest = error.config as AxiosRequestConfig & { _retried?: boolean };
    const status = error.response?.status;

    // Only attempt refresh for 401s that haven't already been retried.
    if (status !== 401 || originalRequest._retried) {
      return Promise.reject(error);
    }

    const { refreshToken, setAccessToken, logout } = useAuthStore.getState();
    if (!refreshToken) {
      logout();
      return Promise.reject(error);
    }

    if (isRefreshing) {
      // Queue this request until the in-flight refresh resolves.
      return new Promise<unknown>((resolve, reject) => {
        pendingQueue.push({
          resolve: (token) => {
            if (originalRequest.headers) {
              originalRequest.headers["Authorization"] = `Bearer ${token}`;
            }
            resolve(apiClient(originalRequest));
          },
          reject,
        });
      });
    }

    originalRequest._retried = true;
    isRefreshing = true;

    try {
      const { data } = await axios.post<{ access_token: string; expires_in: number }>(
        `${BASE_URL}/auth/refresh`,
        { refresh_token: refreshToken },
      );
      setAccessToken(data.access_token, data.expires_in);
      drainQueue(null, data.access_token);

      if (originalRequest.headers) {
        originalRequest.headers["Authorization"] = `Bearer ${data.access_token}`;
      }
      return apiClient(originalRequest);
    } catch (refreshError) {
      drainQueue(refreshError, null);
      logout();
      return Promise.reject(refreshError);
    } finally {
      isRefreshing = false;
    }
  },
);
