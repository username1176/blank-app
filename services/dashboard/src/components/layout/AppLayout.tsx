import { Outlet }          from "react-router-dom";
import Sidebar             from "./Sidebar";
import TopBar              from "./TopBar";
import { useTokenRefresh } from "../../hooks/useTokenRefresh";

/**
 * Root shell for all authenticated pages.
 *
 * Mounts useTokenRefresh here so the proactive refresh scheduler runs for the
 * entire authenticated session — it needs to live above the page-level Outlet
 * so it isn't unmounted on page transitions.
 */
export default function AppLayout() {
  useTokenRefresh();

  return (
    <div className="flex min-h-screen">
      <Sidebar />

      <div className="flex flex-col flex-1 min-w-0">
        <TopBar />

        <main className="flex-1 overflow-y-auto p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
