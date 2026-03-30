import { Outlet } from "react-router-dom";
import Sidebar    from "./Sidebar";
import TopBar     from "./TopBar";

/**
 * Root shell for all authenticated pages.
 * Renders the sidebar, top bar, and a scrollable main content area
 * where child routes are mounted via <Outlet />.
 */
export default function AppLayout() {
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
