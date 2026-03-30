import { useEffect }          from "react";
import { useQuery }            from "@tanstack/react-query";
import { useUiStore }          from "../store/uiStore";
import { fetchSites }          from "../api/sites";
import { fetchAlerts }         from "../api/alerts";
import { fetchLatestMoisturePerSite } from "../api/moisture";
import { fetchInventory }      from "../api/inventory";
import SiteMap                 from "../components/maps/SiteMap";
import { SeverityBadge }       from "../components/ui/Badge";
import { PageLoader }          from "../components/ui/LoadingSpinner";
import type { AlertSeverity }  from "../types";

// ── Stat card ──────────────────────────────────────────────────────────────────

interface StatCardProps {
  label:    string;
  value:    string | number;
  sub?:     string;
  accent?:  string;
}

function StatCard({ label, value, sub, accent = "text-slate-800" }: StatCardProps) {
  return (
    <div className="bg-white rounded-xl border border-slate-200 p-5 shadow-sm">
      <p className="text-xs font-medium text-slate-500 uppercase tracking-wide">{label}</p>
      <p className={`mt-1 text-3xl font-bold ${accent}`}>{value}</p>
      {sub && <p className="mt-1 text-xs text-slate-400">{sub}</p>}
    </div>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────────

export default function Dashboard() {
  const setPageTitle = useUiStore((s) => s.setPageTitle);
  useEffect(() => { setPageTitle("Dashboard"); }, [setPageTitle]);

  const sitesQuery = useQuery({
    queryKey: ["sites"],
    queryFn:  fetchSites,
  });

  const alertsQuery = useQuery({
    queryKey: ["alerts", { status: "open", limit: 6 }],
    queryFn:  () => fetchAlerts({ status: "open", limit: 6 }),
  });

  const moistureQuery = useQuery({
    queryKey: ["moisture", "latest"],
    queryFn:  fetchLatestMoisturePerSite,
    refetchInterval: 60_000,
  });

  const inventoryQuery = useQuery({
    queryKey: ["inventory", { limit: 1 }],
    queryFn:  () => fetchInventory({ limit: 1 }),
  });

  const sites     = sitesQuery.data    ?? [];
  const alerts    = alertsQuery.data?.data ?? [];
  const openCount = alertsQuery.data?.total ?? 0;

  const criticalCount = alerts.filter((a) => a.severity === "critical").length;
  const lowMoisture   = (moistureQuery.data ?? []).filter((r) => r.moisturePercent < 20).length;
  const totalItems    = inventoryQuery.data?.total ?? 0;

  return (
    <div className="space-y-6">
      {/* KPI row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Total Sites"         value={sites.length}  sub="across all locations" />
        <StatCard label="Open Alerts"         value={openCount}     sub={`${criticalCount} critical`} accent={openCount > 0 ? "text-red-600" : "text-slate-800"} />
        <StatCard label="Low Moisture Sites"  value={lowMoisture}   sub="below 20% threshold"  accent={lowMoisture > 0 ? "text-amber-600" : "text-slate-800"} />
        <StatCard label="Inventory Items"     value={totalItems}    sub="tracked materials" />
      </div>

      {/* Map + recent alerts */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Map */}
        <div className="lg:col-span-2 bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
          <div className="px-5 py-3 border-b border-slate-100 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-700">Site Locations</h2>
            <span className="text-xs text-slate-400">{sites.length} sites</span>
          </div>
          {sitesQuery.isLoading ? (
            <PageLoader />
          ) : (
            <SiteMap sites={sites} className="w-full h-72" />
          )}
        </div>

        {/* Recent alerts */}
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm flex flex-col">
          <div className="px-5 py-3 border-b border-slate-100">
            <h2 className="text-sm font-semibold text-slate-700">Recent Alerts</h2>
          </div>
          <div className="flex-1 overflow-y-auto divide-y divide-slate-100">
            {alertsQuery.isLoading && <PageLoader />}
            {!alertsQuery.isLoading && alerts.length === 0 && (
              <p className="p-5 text-sm text-slate-400 text-center">No open alerts</p>
            )}
            {alerts.map((alert) => (
              <div key={alert.id} className="px-5 py-3">
                <div className="flex items-start gap-2">
                  <SeverityBadge severity={alert.severity as AlertSeverity} />
                  <div className="min-w-0">
                    <p className="text-xs font-medium text-slate-700 truncate">{alert.type}</p>
                    <p className="text-xs text-slate-500 mt-0.5 line-clamp-2">{alert.message}</p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
