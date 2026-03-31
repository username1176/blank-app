import { useEffect, useState } from "react";
import { useQuery }             from "@tanstack/react-query";
import { useUiStore }           from "../store/uiStore";
import { fetchSites }           from "../api/sites";
import { fetchMoistureReadings } from "../api/moisture";
import MoistureChart            from "../components/charts/MoistureChart";
import MoistureHeatmap          from "../components/moisture/MoistureHeatmap";
import { PageLoader }           from "../components/ui/LoadingSpinner";
import type { MoistureTimeRange } from "../types";

const TIME_RANGES: Array<{ label: string; value: MoistureTimeRange }> = [
  { label: "24 h", value: "24h" },
  { label: "7 d",  value: "7d"  },
  { label: "30 d", value: "30d" },
];

function statRow(label: string, value: string) {
  return (
    <div key={label} className="flex justify-between items-center py-2 border-b border-slate-100 last:border-0">
      <span className="text-xs text-slate-500">{label}</span>
      <span className="text-sm font-semibold text-slate-800">{value}</span>
    </div>
  );
}

export default function Moisture() {
  const setPageTitle = useUiStore((s) => s.setPageTitle);
  useEffect(() => { setPageTitle("Moisture"); }, [setPageTitle]);

  const [selectedSiteId, setSelectedSiteId] = useState<string>("");
  const [timeRange,      setTimeRange]      = useState<MoistureTimeRange>("24h");

  const sitesQuery = useQuery({ queryKey: ["sites"], queryFn: fetchSites });

  // Auto-select first site once loaded
  useEffect(() => {
    if (!selectedSiteId && sitesQuery.data?.length) {
      setSelectedSiteId(sitesQuery.data[0]!.id);
    }
  }, [sitesQuery.data, selectedSiteId]);

  const readingsQuery = useQuery({
    queryKey: ["moisture", "readings", selectedSiteId, timeRange],
    queryFn:  () => fetchMoistureReadings(selectedSiteId, timeRange),
    enabled:  !!selectedSiteId,
    refetchInterval: 60_000,
  });

  const readings = readingsQuery.data ?? [];

  const moistureValues = readings.map((r) => r.moisturePercent);
  const stats = moistureValues.length > 0 ? {
    min:  Math.min(...moistureValues).toFixed(1),
    max:  Math.max(...moistureValues).toFixed(1),
    avg:  (moistureValues.reduce((a, b) => a + b, 0) / moistureValues.length).toFixed(1),
    last: moistureValues[moistureValues.length - 1]!.toFixed(1),
  } : null;

  return (
    <div className="space-y-6">

      {/* ── Controls ─────────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-3">
        <select
          value={selectedSiteId}
          onChange={(e) => setSelectedSiteId(e.target.value)}
          className="rounded-lg border border-slate-300 px-3 py-2 text-sm bg-white
                     focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          <option value="" disabled>Select a site</option>
          {(sitesQuery.data ?? []).map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>

        <div className="flex gap-1 bg-slate-100 rounded-lg p-1">
          {TIME_RANGES.map((r) => (
            <button
              key={r.value}
              onClick={() => setTimeRange(r.value)}
              className={`px-3 py-1 text-xs font-medium rounded-md transition-colors
                ${timeRange === r.value
                  ? "bg-white text-slate-800 shadow-sm"
                  : "text-slate-500 hover:text-slate-700"
                }`}
            >
              {r.label}
            </button>
          ))}
        </div>

        {readingsQuery.isFetching && (
          <span className="text-xs text-slate-400 animate-pulse">Updating…</span>
        )}
      </div>

      {/* ── Time-series chart + stats ─────────────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
        <div className="lg:col-span-3 bg-white rounded-xl border border-slate-200 shadow-sm p-5">
          <h2 className="text-sm font-semibold text-slate-700 mb-4">
            Moisture &amp; Temperature — {timeRange}
          </h2>
          {readingsQuery.isLoading ? (
            <PageLoader />
          ) : readings.length === 0 ? (
            <p className="text-sm text-slate-400 text-center py-16">No readings for this period.</p>
          ) : (
            <MoistureChart readings={readings} className="h-64" />
          )}
        </div>

        <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5">
          <h2 className="text-sm font-semibold text-slate-700 mb-3">Statistics</h2>
          {stats ? (
            <div>
              {statRow("Minimum", `${stats.min}%`)}
              {statRow("Maximum", `${stats.max}%`)}
              {statRow("Average", `${stats.avg}%`)}
              {statRow("Latest",  `${stats.last}%`)}
              {statRow("Readings", String(readings.length))}
            </div>
          ) : (
            <p className="text-xs text-slate-400">No data</p>
          )}
        </div>
      </div>

      {/* ── Pile zone heatmap ─────────────────────────────────────────────────── */}
      {selectedSiteId && (
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5">
          <MoistureHeatmap siteId={selectedSiteId} />
        </div>
      )}

    </div>
  );
}
