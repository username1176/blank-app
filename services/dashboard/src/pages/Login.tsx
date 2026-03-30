/**
 * Login page.
 *
 * Behaviour:
 *   • Already-authenticated users are redirected to their intended destination
 *     (or /dashboard) as soon as the persist store finishes hydrating.
 *   • When the Axios interceptor forces a logout due to an expired refresh
 *     token, the store's sessionExpired flag is true.  The page shows a banner
 *     explaining what happened, then clears the flag so it doesn't re-appear
 *     on the next visit.
 *   • Login errors are mapped to plain-English messages in the useAuth hook;
 *     this component just renders whatever string it receives.
 */

import { useState, type FormEvent, useEffect } from "react";
import { useNavigate, useLocation }             from "react-router-dom";
import { useAuth }                              from "../hooks/useAuth";
import { useAuthStore }                         from "../store/authStore";
import LoadingSpinner                           from "../components/ui/LoadingSpinner";

export default function Login() {
  const navigate  = useNavigate();
  const location  = useLocation();
  const auth      = useAuth();

  // Where to send the user after a successful login.
  const from = (location.state as { from?: { pathname: string } })?.from?.pathname ?? "/dashboard";

  // Wait for the persist store to hydrate before deciding to redirect.
  const _hydrated = useAuthStore((s) => s._hydrated);

  // Redirect already-authenticated users away from this page.
  useEffect(() => {
    if (_hydrated && auth.isAuthenticated) {
      navigate(from, { replace: true });
    }
  }, [_hydrated, auth.isAuthenticated, from, navigate]);

  // Capture the session-expired flag on first render, then clear it from the
  // store so it doesn't reappear if the user navigates away and comes back.
  const [showExpiredBanner, setShowExpiredBanner] = useState(auth.sessionExpired);
  useEffect(() => {
    if (auth.sessionExpired) {
      setShowExpiredBanner(true);
      auth.clearSessionExpired();
    }
  // Only run on mount — intentionally omitting auth from deps.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [email,    setEmail]    = useState("");
  const [password, setPassword] = useState("");
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState<string | null>(null);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setShowExpiredBanner(false);
    setLoading(true);

    try {
      await auth.login(email, password);
      navigate(from, { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed — please try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 px-4">
      <div className="w-full max-w-sm">

        {/* Logo + heading */}
        <div className="flex flex-col items-center mb-8">
          <div className="w-12 h-12 rounded-xl bg-blue-600 flex items-center justify-center shadow-lg mb-3">
            <svg className="w-7 h-7 text-white" fill="currentColor" viewBox="0 0 20 20">
              <path d="M10.707 2.293a1 1 0 00-1.414 0l-7 7a1 1 0 001.414 1.414L4 10.414V17a1 1 0 001 1h2a1 1 0 001-1v-2a1 1 0 011-1h2a1 1 0 011 1v2a1 1 0 001 1h2a1 1 0 001-1v-6.586l.293.293a1 1 0 001.414-1.414l-7-7z" />
            </svg>
          </div>
          <h1 className="text-xl font-semibold text-slate-800">Warehouse Monitoring</h1>
          <p className="text-sm text-slate-500 mt-1">Sign in to your account</p>
        </div>

        {/* Card */}
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6 space-y-4">

          {/* Session-expired banner */}
          {showExpiredBanner && (
            <div className="flex items-start gap-3 rounded-lg bg-amber-50 border border-amber-200 px-4 py-3">
              <svg className="w-4 h-4 text-amber-500 mt-0.5 shrink-0" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" clipRule="evenodd"
                  d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" />
              </svg>
              <div>
                <p className="text-sm font-medium text-amber-800">Your session has expired</p>
                <p className="text-xs text-amber-700 mt-0.5">
                  Please sign in again to continue.
                </p>
              </div>
            </div>
          )}

          {/* API / validation error */}
          {error && (
            <div className="flex items-start gap-3 rounded-lg bg-red-50 border border-red-200 px-4 py-3">
              <svg className="w-4 h-4 text-red-500 mt-0.5 shrink-0" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" clipRule="evenodd"
                  d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" />
              </svg>
              <p className="text-sm text-red-700">{error}</p>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label htmlFor="email" className="block text-sm font-medium text-slate-700 mb-1">
                Email
              </label>
              <input
                id="email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm shadow-sm
                           placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500
                           focus:border-transparent transition"
                placeholder="you@company.com"
              />
            </div>

            <div>
              <label htmlFor="password" className="block text-sm font-medium text-slate-700 mb-1">
                Password
              </label>
              <input
                id="password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm shadow-sm
                           placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500
                           focus:border-transparent transition"
                placeholder="••••••••"
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full flex items-center justify-center gap-2 rounded-lg bg-blue-600
                         px-4 py-2.5 text-sm font-semibold text-white shadow-sm
                         hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500
                         focus:ring-offset-2 disabled:opacity-60 disabled:cursor-not-allowed transition"
            >
              {loading && <LoadingSpinner size="sm" className="text-white" />}
              {loading ? "Signing in…" : "Sign in"}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
