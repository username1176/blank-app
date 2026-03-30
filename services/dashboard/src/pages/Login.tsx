import { useState, type FormEvent } from "react";
import { useNavigate, useLocation }  from "react-router-dom";
import { useAuthStore }              from "../store/authStore";
import { login as apiLogin }         from "../api/auth";
import LoadingSpinner                from "../components/ui/LoadingSpinner";
import type { AuthUser }             from "../types";

/** Decode the customer_id, site_ids etc. from an access token without verifying the signature. */
function decodeAccessToken(token: string): AuthUser | null {
  try {
    const payload = JSON.parse(atob(token.split(".")[1] ?? "")) as Record<string, unknown>;
    return {
      userId:     String(payload["sub"] ?? ""),
      customerId: String(payload["customer_id"] ?? ""),
      email:      typeof payload["email"] === "string" ? payload["email"] : null,
      siteIds:    Array.isArray(payload["site_ids"])
        ? (payload["site_ids"] as unknown[]).map(String)
        : [],
    };
  } catch {
    return null;
  }
}

export default function Login() {
  const navigate    = useNavigate();
  const location    = useLocation();
  const setSession  = useAuthStore((s) => s.setSession);

  const from = (location.state as { from?: { pathname: string } })?.from?.pathname ?? "/dashboard";

  const [email,    setEmail]    = useState("");
  const [password, setPassword] = useState("");
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState<string | null>(null);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const tokens = await apiLogin({ email, password });
      const user   = decodeAccessToken(tokens.access_token);

      if (!user) throw new Error("Invalid token received from server");

      setSession(tokens, user);
      navigate(from, { replace: true });
    } catch (err: unknown) {
      const msg =
        err instanceof Error
          ? err.message
          : "Login failed — please check your credentials";
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 px-4">
      <div className="w-full max-w-sm">
        {/* Logo */}
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
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
          <form onSubmit={handleSubmit} className="space-y-4">
            {error && (
              <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
                {error}
              </div>
            )}

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
