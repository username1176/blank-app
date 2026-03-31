/**
 * Inventory dashboard page.
 *
 * Layout:
 *   ┌─────────────────────────────────────────────────┐
 *   │  Summary stats bar  │  "Next refresh in Xs"      │
 *   ├─────────────────────────────────────────────────┤
 *   │  Site cards grid  (click to select for chart)   │
 *   ├─────────────────────────────────────────────────┤
 *   │  30-day history chart for selected / all sites  │
 *   └─────────────────────────────────────────────────┘
 *
 * All data auto-refreshes every 60 seconds via React Query.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useUiStore }              from "../store/uiStore";
import { useInventoryDashboard }   from "../hooks/useInventoryDashboard";
import SiteInventoryCard           from "../components/inventory/SiteInventoryCard";
import InventoryHistoryChart       from "../components/inventory/InventoryHistoryChart";
import { PageLoader }              from "../components/ui/LoadingSpinner";

// ── RefreshCountdown ──────────────────────────────────────────────────────────

const INTERVAL_MS = 60_000;

interface CountdownProps {
  dataUpdatedAt: number | null;
  onRefresh:     () => void;
}

function RefreshCountdown({ dataUpdatedAt, onRefresh }: CountdownProps) {
  const [seconds, setSeconds] = useState(INTERVAL_MS / 1000);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const resetTimer = useCallback(() => {
    if (tickRef.current) clearInterval(tickRef.current);
    setSeconds(INTERVAL_MS / 1000);
    tickRef.current = setInterval(() => {
      setSeconds((s) => {
        if (s <= 1) { return INTERVAL_MS / 1000; }
        return s - 1;
      });
    }, 1000);
  }, []);

  // Reset countdown whenever the data timestamp changes (i.e. a fetch landed).
  useEffect(() => {
    resetTimer();
    return () => { if (tickRef.current) clearInterval(tickRef.current); };
  }, [dataUpdatedAt, resetTimer]);

  return (
    <div className="flex items-center gap-2 text-sm text-slate-500">
      <svg className="w-4 h-4 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <circle cx="12" cy="12" r="10" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6l4 2" />
      </svg>
      <span>Next refresh in {seconds}s</span>
      <button
        onClick={() => { onRefresh(); resetTimer(); }}
        className="text-blue-600 hover:text-blue-800 hover:underline ml-1"
      >
        Refresh now
      </button>
    </div>
  );
}

// ── StatCard ──────────────────────────────────────────────────────────────────

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="bg-white rounded-xl border border-slate-200 shadow-sm px-5 py-4">
      <p className="text-xs font-medium text-slate-500 uppercase tracking-wide">{label}</p>
      <p className="text-2xl font-bold text-slate-800 mt-1 tabular-nums">{value}</p>
      {sub && <p className="text-xs text-slate-400 mt-0.5">{sub}</p>}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function Inventory() {
  const setPageTitle = useUiStore((s) => s.setPageTitle);
  useEffect(() => { setPageTitle("Inventory"); }, [setPageTitle]);

  const [selectedSiteId, setSelectedSiteId] = useState<string | null>(null);
  const [searchQuery,    setSearchQuery]    = useState("");

  const {
    sites,
    allItems,
    historySnapshots,
    totalVolume,
    totalPiles,
    itemsBySite,
    alertsBySite,
    anomalySiteIds,
    isLoading,
    isError,
    dataUpdatedAt,
    refreshAll,
  } = useInventoryDashboard(selectedSiteId);

  const handleCardClick = (siteId: string) => {
    setSelectedSiteId((prev) => (prev === siteId ? null : siteId));
  };

  // Filter sites by search query.
  const filteredSites = sites.filter((s) =>
    s.name.toLowerCase().includes(searchQuery.toLowerCase()),
  );

  // Sort: anomaly sites first (critical before warning), then alphabetical.
  const SEVERITY_ORDER: Record<string, number> = { critical: 0, warning: 1 };
  const sortedSites = [...filteredSites].sort((a, b) => {
    const aAlerts  = alertsBySite.get(a.id) ?? [];
    const bAlerts  = alertsBySite.get(b.id) ?? [];
    const aWorst   = aAlerts.reduce((w, al) => Math.min(w, SEVERITY_ORDER[al.severity] ?? 2), 2);
    const bWorst   = bAlerts.reduce((w, al) => Math.min(w, SEVERITY_ORDER[al.severity] ?? 2), 2);
    if (aWorst !== bWorst) return aWorst - bWorst;
    return a.name.localeCompare(b.name);
  });

  const selectedSite = selectedSiteId
    ? sites.find((s) => s.id === selectedSiteId) ?? null
    : null;

  if (isLoading) return <PageLoader />;

  if (isError) {
    return (
      <div className="rounded-xl bg-red-50 border border-red-200 px-6 py-8 text-center">
        <p className="text-sm font-medium text-red-700">Failed to load inventory data.</p>
        <button onClick={refreshAll} className="mt-3 text-sm text-red-600 hover:underline">
          Try again
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">

      {/* ── Header row ─────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-slate-800">
          {selectedSite ? selectedSite.name : "All Sites"}
          {selectedSite && (
            <button
              onClick={() => setSelectedSiteId(null)}
              className="ml-2 text-sm font-normal text-blue-600 hover:underline"
            >
              ← All sites
            </button>
          )}
        </h2>
        <RefreshCountdown dataUpdatedAt={dataUpdatedAt} onRefresh={refreshAll} />
      </div>

      {/* ── Summary stats ──────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <StatCard
          label="Total Volume"
          value={totalVolume >= 1000
            ? `${(totalVolume / 1000).toFixed(1)}k m³`
            : `${totalVolume.toFixed(0)} m³`}
          sub="across all sites"
        />
        <StatCard
          label="Total Piles"
          value={totalPiles.toLocaleString()}
          sub={`${allItems.length} material types`}
        />
        <StatCard
          label="Sites"
          value={String(sites.length)}
          sub={`${anomalySiteIds.size} with active alerts`}
        />
        <StatCard
          label="Anomalies"
          value={String(anomalySiteIds.size)}
          sub={anomalySiteIds.size === 0 ? "All clear" : "Sites need attention"}
        />
      </div>

      {/* ── Site cards grid ─────────────────────────────────────────────────── */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-slate-700">
            Sites
            <span className="ml-1.5 text-xs font-normal text-slate-400">
              (click to view site history)
            </span>
          </h3>
          <input
            type="search"
            placeholder="Search sites…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm w-44
                       focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>

        {sortedSites.length === 0 ? (
          <p className="text-sm text-slate-400 text-center py-8">
            {searchQuery ? "No sites match your search." : "No sites found."}
          </p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {sortedSites.map((site) => (
              <SiteInventoryCard
                key={site.id}
                site={site}
                items={itemsBySite.get(site.id) ?? []}
                alerts={alertsBySite.get(site.id) ?? []}
                isSelected={selectedSiteId === site.id}
                onClick={() => handleCardClick(site.id)}
              />
            ))}
          </div>
        )}
      </div>

      {/* ── 30-day history chart ─────────────────────────────────────────────── */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-slate-700">
            30-Day Volume History
            {selectedSite && (
              <span className="ml-1.5 font-normal text-slate-400">— {selectedSite.name}</span>
            )}
          </h3>
          {historySnapshots.length > 0 && (
            <span className="text-xs text-slate-400">
              {historySnapshots.length} day{historySnapshots.length !== 1 ? "s" : ""} of data
            </span>
          )}
        </div>

        <InventoryHistoryChart
          snapshots={historySnapshots}
          sites={sites}
          selectedSiteId={selectedSiteId}
          isLoading={false}
        />
      </div>

    </div>
  );
}
