/**
 * ProtectedRoute — guards all authenticated routes.
 *
 * Two-phase check:
 *
 *   1. Hydration guard — Zustand's persist middleware reads from localStorage
 *      asynchronously.  Before it finishes, isAuthenticated is always false
 *      (the store's initial value), which would redirect logged-in users to the
 *      login page on every page refresh.  We wait for _hydrated to be true
 *      before making any routing decision, showing a full-page spinner in the
 *      meantime.  The spinner is typically visible for < one render frame.
 *
 *   2. Auth check — once the store is hydrated, redirect to /login if the user
 *      is not authenticated, preserving the intended path in location.state.from
 *      so Login.tsx can redirect back after a successful sign-in.
 */

import { Navigate, Outlet, useLocation } from "react-router-dom";
import { useAuthStore }                  from "../../store/authStore";
import LoadingSpinner                    from "../ui/LoadingSpinner";

export default function ProtectedRoute() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const _hydrated       = useAuthStore((s) => s._hydrated);
  const location        = useLocation();

  // Phase 1 — wait for localStorage rehydration.
  if (!_hydrated) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  // Phase 2 — auth check.
  if (!isAuthenticated) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  return <Outlet />;
}
