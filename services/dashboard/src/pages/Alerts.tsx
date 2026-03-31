/**
 * Alert Center — two-tab page.
 *
 * Tab 1 "Alerts":
 *   • Filters: status tabs, site, severity, alert type (text search)
 *   • Summary bar: open/critical counts
 *   • Alert list with severity indicator, acknowledge in-line, click-to-open modal
 *   • AlertDetailModal with timeline + acknowledge/resolve
 *
 * Tab 2 "Notification Settings":
 *   • NotificationSettingsPanel (channels + thresholds)
 */

import { useEffect, useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useUiStore }          from "../store/uiStore";
import { fetchAlerts, acknowledgeAlert, resolveAlert } from "../api/alerts";
import { fetchSites }          from "../api/sites";
import { SeverityBadge, StatusBadge } from "../components/ui/Badge";
import { PageLoader }          from "../components/ui/LoadingSpinner";
import AlertDetailModal        from "../components/alerts/AlertDetailModal";
import NotificationSettingsPanel from "../components/alerts/NotificationSettingsPanel";
import type { Alert, AlertStatus, AlertSeverity } from "../types";

// ── Constants ─────────────────────────────────────────────────────────────────

const STATUS_TABS: Array<{ label: string; value: AlertStatus | "all" }> = [
  { label: "All",          value: "all"          },
  { label: "Open",         value: "open"         },
  { label: "Acknowledged", value: "acknowledged" },
  { label: "Resolved",     value: "resolved"     },
];

const SEVERITY_OPTIONS: Array<{ label: string; value: AlertSeverity | "" }> = [
  { label: "All severities", value: ""         },
  { label: "Info",           value: "info"     },
  { label: "Warning",        value: "warning"  },
  { label: "Critical",       value: "critical" },
];

const SEVERITY_BAR: Record<AlertSeverity, string> = {
  info:     "bg-blue-400",
  warning:  "bg-amber-500",
  critical: "bg-red-500",
};

const PAGE_SIZE = 15;

// ── Helper ────────────────────────────────────────────────────────────────────

function relTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60_000);
  if (m < 1)   return "just now";
  if (m < 60)  return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24)  return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// ── Summary stat pill ─────────────────────────────────────────────────────────

function StatPill({
  label,
  value,
  colorClass,
}: {
  label:      string;
  value:      number;
  colorClass: string;
}) {
  return (
    <div className={`flex items-center gap-2 px-4 py-2 rounded-full text-sm font-medium ${colorClass}`}>
      <span className="tabular-nums font-bold">{value}</span>
      <span className="font-normal">{label}</span>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

type PageTab = "alerts" | "settings";

export default function Alerts() {
  const setPageTitle  = useUiStore((s) => s.setPageTitle);
  useEffect(() => { setPageTitle("Alert Center"); }, [setPageTitle]);

  const queryClient = useQueryClient();

  // ── Page tab ───────────────────────────────────────────────────────────────
  const [pageTab, setPageTab] = useState<PageTab>("alerts");

  // ── Alert filters ──────────────────────────────────────────────────────────
  const [statusTab,      setStatusTab]      = useState<AlertStatus | "all">("open");
  const [siteFilter,     setSiteFilter]     = useState("");
  const [severityFilter, setSeverityFilter] = useState<AlertSeverity | "">("");
  const [typeSearch,     setTypeSearch]     = useState("");
  const [page,           setPage]           = useState(1);

  // ── Selected alert (modal) ─────────────────────────────────────────────────
  const [selectedAlert, setSelectedAlert] = useState<Alert | null>(null);

  // ── Queries ────────────────────────────────────────────────────────────────
  const sitesQuery = useQuery({ queryKey: ["sites"], queryFn: fetchSites });

  const alertsQuery = useQuery({
    queryKey: ["alerts", { status: statusTab, siteId: siteFilter, severity: severityFilter, type: typeSearch, page }],
    queryFn:  () => fetchAlerts({
      status:   statusTab === "all" ? undefined : statusTab,
      siteId:   siteFilter      || undefined,
      severity: severityFilter  || undefined,
      type:     typeSearch.trim() || undefined,
      page,
      limit:    PAGE_SIZE,
    }),
    placeholderData: (prev) => prev,
    refetchInterval: 30_000,
  });

  // Open alerts for summary bar (unfiltered)
  const openCountQuery = useQuery({
    queryKey: ["alerts-summary"],
    queryFn:  () => fetchAlerts({ status: "open", limit: 1 }),
    refetchInterval: 30_000,
  });
  const criticalCountQuery = useQuery({
    queryKey: ["alerts-summary-critical"],
    queryFn:  () => fetchAlerts({ status: "open", severity: "critical", limit: 1 }),
    refetchInterval: 30_000,
  });

  // ── Mutations ──────────────────────────────────────────────────────────────

  const invalidateAlerts = () => {
    void queryClient.invalidateQueries({ queryKey: ["alerts"] });
  };

  const acknowledgeMutation = useMutation({
    mutationFn: acknowledgeAlert,
    onSuccess: (updated) => {
      invalidateAlerts();
      // Refresh the selected alert in the modal
      if (selectedAlert?.id === updated.id) setSelectedAlert(updated);
    },
  });

  const resolveMutation = useMutation({
    mutationFn: resolveAlert,
    onSuccess: (updated) => {
      invalidateAlerts();
      if (selectedAlert?.id === updated.id) setSelectedAlert(updated);
    },
  });

  // ── Derived ────────────────────────────────────────────────────────────────
  const alerts     = alertsQuery.data?.data      ?? [];
  const total      = alertsQuery.data?.total     ?? 0;
  const totalPages = alertsQuery.data?.totalPages ?? 1;

  const siteMap = useMemo(
    () => Object.fromEntries((sitesQuery.data ?? []).map((s) => [s.id, s.name])),
    [sitesQuery.data],
  );

  function resetFilters() {
    setPage(1);
    setStatusTab("open");
    setSiteFilter("");
    setSeverityFilter("");
    setTypeSearch("");
  }

  const hasActiveFilters =
    statusTab !== "open" || siteFilter || severityFilter || typeSearch.trim();

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <>
      <div className="space-y-5">

        {/* ── Page tabs ──────────────────────────────────────────────────────── */}
        <div className="flex items-center gap-1 border-b border-slate-200">
          {(["alerts", "settings"] as PageTab[]).map((tab) => (
            <button
              key={tab}
              onClick={() => setPageTab(tab)}
              className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors
                ${pageTab === tab
                  ? "border-blue-600 text-blue-700"
                  : "border-transparent text-slate-500 hover:text-slate-700"
                }`}
            >
              {tab === "alerts" ? (
                <span className="flex items-center gap-2">
                  Alerts
                  {(openCountQuery.data?.total ?? 0) > 0 && (
                    <span className="inline-flex items-center justify-center w-5 h-5 rounded-full
                                     bg-red-500 text-white text-xs font-bold leading-none">
                      {openCountQuery.data!.total > 99 ? "99+" : openCountQuery.data!.total}
                    </span>
                  )}
                </span>
              ) : "Notification Settings"}
            </button>
          ))}
        </div>

        {pageTab === "alerts" ? (
          <div className="space-y-4">

            {/* ── Summary bar ──────────────────────────────────────────────── */}
            <div className="flex flex-wrap gap-2">
              <StatPill
                label="open"
                value={openCountQuery.data?.total ?? 0}
                colorClass="bg-red-50 text-red-700"
              />
              <StatPill
                label="critical"
                value={criticalCountQuery.data?.total ?? 0}
                colorClass="bg-red-100 text-red-800"
              />
              <StatPill
                label="total matching"
                value={total}
                colorClass="bg-slate-100 text-slate-600"
              />
            </div>

            {/* ── Filters ──────────────────────────────────────────────────── */}
            <div className="flex flex-wrap items-center gap-3">
              {/* Status tabs */}
              <div className="flex gap-1 bg-slate-100 rounded-lg p-1">
                {STATUS_TABS.map((t) => (
                  <button
                    key={t.value}
                    onClick={() => { setStatusTab(t.value); setPage(1); }}
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

              {/* Site */}
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

              {/* Severity */}
              <select
                value={severityFilter}
                onChange={(e) => { setSeverityFilter(e.target.value as AlertSeverity | ""); setPage(1); }}
                className="rounded-lg border border-slate-300 px-3 py-2 text-sm bg-white
                           focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                {SEVERITY_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>

              {/* Type search */}
              <div className="relative">
                <svg className="absolute left-3 top-2.5 w-4 h-4 text-slate-400 pointer-events-none"
                     fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round"
                    d="M21 21l-4.35-4.35m0 0A7 7 0 1116.65 16.65z" />
                </svg>
                <input
                  type="search"
                  value={typeSearch}
                  onChange={(e) => { setTypeSearch(e.target.value); setPage(1); }}
                  placeholder="Filter by type…"
                  className="pl-9 pr-3 py-2 rounded-lg border border-slate-300 text-sm w-44
                             focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>

              {hasActiveFilters && (
                <button
                  onClick={resetFilters}
                  className="text-xs text-slate-500 hover:text-slate-700 hover:underline"
                >
                  Reset filters
                </button>
              )}

              {alertsQuery.isFetching && (
                <span className="text-xs text-slate-400 animate-pulse ml-auto">Updating…</span>
              )}
            </div>

            {/* ── Alert list ───────────────────────────────────────────────── */}
            {alertsQuery.isLoading ? (
              <PageLoader />
            ) : (
              <div className="space-y-2">
                {alerts.map((alert) => (
                  <div
                    key={alert.id}
                    onClick={() => setSelectedAlert(alert)}
                    className="bg-white rounded-xl border border-slate-200 shadow-sm px-4 py-3.5
                               flex items-start gap-3 cursor-pointer hover:border-blue-300
                               hover:shadow-md transition-all group"
                  >
                    {/* Severity bar */}
                    <div className={`mt-1 w-1 self-stretch rounded-full shrink-0
                      ${SEVERITY_BAR[alert.severity as AlertSeverity]}`}
                    />

                    {/* Body */}
                    <div className="flex-1 min-w-0">
                      <div className="flex flex-wrap items-center gap-2 mb-0.5">
                        <span className="text-sm font-semibold text-slate-800 truncate">
                          {alert.type}
                        </span>
                        <SeverityBadge severity={alert.severity as AlertSeverity} />
                        <StatusBadge   status={alert.status   as AlertStatus}   />
                      </div>
                      <p className="text-sm text-slate-600 line-clamp-2">{alert.message}</p>
                      <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-slate-400">
                        <span>{siteMap[alert.siteId] ?? alert.siteId}</span>
                        <span>{relTime(alert.createdAt)}</span>
                        {alert.acknowledgedAt && (
                          <span>Ack'd {relTime(alert.acknowledgedAt)}</span>
                        )}
                      </div>
                    </div>

                    {/* Inline acknowledge button */}
                    {alert.status === "open" && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          acknowledgeMutation.mutate(alert.id);
                        }}
                        disabled={acknowledgeMutation.isPending}
                        className="shrink-0 self-center text-xs font-medium text-amber-700
                                   px-3 py-1.5 rounded-lg border border-amber-200 bg-amber-50
                                   hover:bg-amber-100 disabled:opacity-50 transition-colors
                                   opacity-0 group-hover:opacity-100"
                      >
                        Acknowledge
                      </button>
                    )}

                    {/* Chevron hint */}
                    <svg className="w-4 h-4 text-slate-300 group-hover:text-slate-400 shrink-0
                                    self-center transition-colors"
                         fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                    </svg>
                  </div>
                ))}

                {alerts.length === 0 && (
                  <div className="bg-white rounded-xl border border-slate-200 shadow-sm py-16 text-center">
                    <svg className="mx-auto w-10 h-10 text-slate-200 mb-3" fill="none"
                         viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1}>
                      <path strokeLinecap="round" strokeLinejoin="round"
                        d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
                    </svg>
                    <p className="text-slate-400 text-sm">No alerts match your filters.</p>
                    {hasActiveFilters && (
                      <button onClick={resetFilters}
                              className="mt-2 text-sm text-blue-600 hover:underline">
                        Clear filters
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* ── Pagination ───────────────────────────────────────────────── */}
            {totalPages > 1 && (
              <div className="flex items-center justify-between">
                <button
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page === 1}
                  className="text-sm text-slate-600 hover:text-slate-900 disabled:opacity-40
                             px-3 py-1.5 rounded-lg hover:bg-slate-100 transition-colors"
                >
                  ← Previous
                </button>
                <span className="text-sm text-slate-500">Page {page} of {totalPages}</span>
                <button
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  disabled={page === totalPages}
                  className="text-sm text-slate-600 hover:text-slate-900 disabled:opacity-40
                             px-3 py-1.5 rounded-lg hover:bg-slate-100 transition-colors"
                >
                  Next →
                </button>
              </div>
            )}

          </div>
        ) : (
          /* ── Notification settings tab ─────────────────────────────────────── */
          <NotificationSettingsPanel />
        )}

      </div>

      {/* ── Detail modal ─────────────────────────────────────────────────────── */}
      {selectedAlert && (
        <AlertDetailModal
          alert={selectedAlert}
          siteMap={siteMap}
          onClose={() => setSelectedAlert(null)}
          onAcknowledge={(id) => acknowledgeMutation.mutate(id)}
          onResolve={(id)     => resolveMutation.mutate(id)}
          isAcknowledging={acknowledgeMutation.isPending}
          isResolving={resolveMutation.isPending}
        />
      )}
    </>
  );
}
