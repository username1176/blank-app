import { useEffect, useState }  from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useUiStore }            from "../store/uiStore";
import { fetchAlerts, acknowledgeAlert } from "../api/alerts";
import { fetchSites }            from "../api/sites";
import { SeverityBadge, StatusBadge }   from "../components/ui/Badge";
import { PageLoader }            from "../components/ui/LoadingSpinner";
import type { AlertStatus, AlertSeverity } from "../types";

const STATUS_TABS: Array<{ label: string; value: AlertStatus | "all" }> = [
  { label: "All",           value: "all"          },
  { label: "Open",          value: "open"         },
  { label: "Acknowledged",  value: "acknowledged" },
  { label: "Resolved",      value: "resolved"     },
];

const PAGE_SIZE = 15;

export default function Alerts() {
  const setPageTitle  = useUiStore((s) => s.setPageTitle);
  useEffect(() => { setPageTitle("Alerts"); }, [setPageTitle]);

  const [statusTab,  setStatusTab]  = useState<AlertStatus | "all">("open");
  const [siteFilter, setSiteFilter] = useState("");
  const [page,       setPage]       = useState(1);

  const queryClient = useQueryClient();

  const sitesQuery = useQuery({ queryKey: ["sites"], queryFn: fetchSites });

  const alertsQuery = useQuery({
    queryKey: ["alerts", { status: statusTab, siteId: siteFilter, page }],
    queryFn:  () => fetchAlerts({
      status:  statusTab === "all" ? undefined : statusTab,
      siteId:  siteFilter || undefined,
      page,
      limit:   PAGE_SIZE,
    }),
    placeholderData: (prev) => prev,
    refetchInterval: 30_000,
  });

  const acknowledgeMutation = useMutation({
    mutationFn: acknowledgeAlert,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["alerts"] });
    },
  });

  const alerts     = alertsQuery.data?.data      ?? [];
  const total      = alertsQuery.data?.total     ?? 0;
  const totalPages = alertsQuery.data?.totalPages ?? 1;

  const siteMap = Object.fromEntries(
    (sitesQuery.data ?? []).map((s) => [s.id, s.name]),
  );

  const handleTabChange = (v: AlertStatus | "all") => {
    setStatusTab(v);
    setPage(1);
  };

  return (
    <div className="space-y-4">
      {/* Status tabs + site filter */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex gap-1 bg-slate-100 rounded-lg p-1">
          {STATUS_TABS.map((t) => (
            <button
              key={t.value}
              onClick={() => handleTabChange(t.value)}
              className={`px-3 py-1 text-xs font-medium rounded-md transition-colors
                ${statusTab === t.value
                  ? "bg-white text-slate-800 shadow-sm"
                  : "text-slate-500 hover:text-slate-700"
                }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        <select
          value={siteFilter}
          onChange={(e) => { setSiteFilter(e.target.value); setPage(1); }}
          className="rounded-lg border border-slate-300 px-3 py-2 text-sm bg-white
                     focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          <option value="">All sites</option>
          {(sitesQuery.data ?? []).map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>

        <span className="ml-auto text-sm text-slate-400">{total} alert{total !== 1 ? "s" : ""}</span>
      </div>

      {/* Alert list */}
      {alertsQuery.isLoading ? (
        <PageLoader />
      ) : (
        <div className="space-y-2">
          {alerts.map((alert) => (
            <div
              key={alert.id}
              className="bg-white rounded-xl border border-slate-200 shadow-sm px-5 py-4 flex items-start gap-4"
            >
              {/* Severity indicator */}
              <div className={`mt-0.5 w-1.5 self-stretch rounded-full flex-shrink-0
                ${alert.severity === "critical" ? "bg-red-500" : alert.severity === "warning" ? "bg-amber-500" : "bg-blue-400"}
              `} />

              {/* Content */}
              <div className="flex-1 min-w-0">
                <div className="flex flex-wrap items-center gap-2 mb-1">
                  <span className="text-sm font-semibold text-slate-800">{alert.type}</span>
                  <SeverityBadge severity={alert.severity as AlertSeverity} />
                  <StatusBadge status={alert.status as AlertStatus} />
                </div>
                <p className="text-sm text-slate-600">{alert.message}</p>
                <div className="mt-2 flex flex-wrap gap-3 text-xs text-slate-400">
                  <span>{siteMap[alert.siteId] ?? alert.siteId}</span>
                  <span>{new Date(alert.createdAt).toLocaleString()}</span>
                  {alert.acknowledgedAt && (
                    <span>Ack'd {new Date(alert.acknowledgedAt).toLocaleString()}</span>
                  )}
                </div>
              </div>

              {/* Acknowledge button */}
              {alert.status === "open" && (
                <button
                  onClick={() => acknowledgeMutation.mutate(alert.id)}
                  disabled={acknowledgeMutation.isPending}
                  className="flex-shrink-0 text-xs font-medium text-blue-600 hover:text-blue-800
                             px-3 py-1.5 rounded-lg border border-blue-200 hover:bg-blue-50
                             disabled:opacity-50 transition-colors"
                >
                  Acknowledge
                </button>
              )}
            </div>
          ))}

          {alerts.length === 0 && (
            <div className="bg-white rounded-xl border border-slate-200 shadow-sm py-16 text-center">
              <p className="text-slate-400 text-sm">No alerts match your filters.</p>
            </div>
          )}
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page === 1}
            className="text-sm text-slate-600 hover:text-slate-900 disabled:opacity-40 px-3 py-1.5 rounded-lg hover:bg-slate-100 transition-colors"
          >
            ← Previous
          </button>
          <span className="text-sm text-slate-500">Page {page} of {totalPages}</span>
          <button
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page === totalPages}
            className="text-sm text-slate-600 hover:text-slate-900 disabled:opacity-40 px-3 py-1.5 rounded-lg hover:bg-slate-100 transition-colors"
          >
            Next →
          </button>
        </div>
      )}
    </div>
  );
}
