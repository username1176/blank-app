/**
 * InventoryHistoryChart — 30-day inventory volume trend.
 *
 * Single-site mode (selectedSiteId is set):
 *   Renders a gradient-filled AreaChart for that site's daily total volume.
 *
 * All-sites mode (selectedSiteId is null):
 *   Renders a stacked AreaChart, one Area per site, so you can see the
 *   aggregate and per-site contributions at a glance.
 *
 * Both modes include a ReferenceLine at the period average.
 */

import { useMemo }        from "react";
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine, Legend,
} from "recharts";
import type { InventorySnapshot, Site } from "../../types";

// ── Palette for multi-site stacked areas ──────────────────────────────────────

const AREA_COLORS = [
  "#3b82f6", // blue-500
  "#8b5cf6", // violet-500
  "#10b981", // emerald-500
  "#f97316", // orange-500
  "#ec4899", // pink-500
  "#06b6d4", // cyan-500
  "#f59e0b", // amber-500
  "#14b8a6", // teal-500
];

function siteColor(index: number): string {
  return AREA_COLORS[index % AREA_COLORS.length]!;
}

// ── Tooltip formatter ─────────────────────────────────────────────────────────

function formatVolume(v: number): string {
  return v >= 1000 ? `${(v / 1000).toFixed(1)}k m³` : `${v.toFixed(0)} m³`;
}

// ── Props ─────────────────────────────────────────────────────────────────────

interface Props {
  snapshots:      InventorySnapshot[];
  sites:          Site[];
  selectedSiteId: string | null;
  isLoading:      boolean;
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function InventoryHistoryChart({
  snapshots,
  sites,
  selectedSiteId,
  isLoading,
}: Props) {
  // Build recharts data: array of { date, [siteId]: volume, ... }
  const { chartData, visibleSites, average } = useMemo(() => {
    if (snapshots.length === 0) return { chartData: [], visibleSites: [], average: 0 };

    // Dates present in the dataset, sorted ascending.
    const dateSet  = new Set(snapshots.map((s) => s.date));
    const dates    = Array.from(dateSet).sort();

    // Map from siteId → site name for the legend.
    const siteNameMap = Object.fromEntries(sites.map((s) => [s.id, s.name]));

    // Unique site IDs seen in snapshots.
    const siteIds = selectedSiteId
      ? [selectedSiteId]
      : Array.from(new Set(snapshots.map((s) => s.siteId)));

    const visibleSites = siteIds.map((id) => ({
      id,
      name: siteNameMap[id] ?? id,
    }));

    // Index snapshots by [date][siteId] for O(1) lookup.
    const index = new Map<string, Map<string, number>>();
    for (const snap of snapshots) {
      let byDate = index.get(snap.date);
      if (!byDate) { byDate = new Map(); index.set(snap.date, byDate); }
      byDate.set(snap.siteId, snap.totalVolumeCubicM);
    }

    const chartData = dates.map((date) => {
      const byDate = index.get(date) ?? new Map();
      const row: Record<string, number | string> = {
        date: date.slice(5), // "MM-DD"
      };
      for (const id of siteIds) {
        row[id] = byDate.get(id) ?? 0;
      }
      return row;
    });

    // Average of the total per date (sum across all sites).
    const totalPerDate = chartData.map((row) =>
      siteIds.reduce((sum, id) => sum + ((row[id] as number) || 0), 0),
    );
    const average = totalPerDate.length
      ? totalPerDate.reduce((a, b) => a + b, 0) / totalPerDate.length
      : 0;

    return { chartData, visibleSites, average };
  }, [snapshots, sites, selectedSiteId]);

  // ── Loading / empty states ─────────────────────────────────────────────────

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64 text-slate-400 text-sm">
        Loading history…
      </div>
    );
  }

  if (chartData.length === 0) {
    return (
      <div className="flex items-center justify-center h-64 text-slate-400 text-sm">
        No historical data available for this period.
      </div>
    );
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  const isSingle = visibleSites.length === 1;
  const gradientId = "inventoryGradient";

  return (
    <ResponsiveContainer width="100%" height={260}>
      <AreaChart data={chartData} margin={{ top: 10, right: 16, left: 0, bottom: 0 }}>
        <defs>
          {isSingle && (
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%"  stopColor="#3b82f6" stopOpacity={0.25} />
              <stop offset="95%" stopColor="#3b82f6" stopOpacity={0}    />
            </linearGradient>
          )}
        </defs>

        <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />

        <XAxis
          dataKey="date"
          tick={{ fontSize: 11, fill: "#94a3b8" }}
          tickLine={false}
          axisLine={false}
          interval="preserveStartEnd"
        />

        <YAxis
          tickFormatter={(v: number) => (v >= 1000 ? `${(v / 1000).toFixed(0)}k` : String(v))}
          tick={{ fontSize: 11, fill: "#94a3b8" }}
          tickLine={false}
          axisLine={false}
          width={48}
        />

        <Tooltip
          formatter={(value: number, name: string) => [
            formatVolume(value),
            visibleSites.find((s) => s.id === name)?.name ?? name,
          ]}
          labelStyle={{ color: "#475569", fontSize: 12 }}
          contentStyle={{ borderRadius: 8, border: "1px solid #e2e8f0", fontSize: 12 }}
        />

        {!isSingle && <Legend formatter={(id: string) => visibleSites.find((s) => s.id === id)?.name ?? id} />}

        <ReferenceLine
          y={average}
          stroke="#94a3b8"
          strokeDasharray="4 4"
          label={{ value: "avg", position: "insideTopRight", fontSize: 10, fill: "#94a3b8" }}
        />

        {visibleSites.map((site, idx) => (
          <Area
            key={site.id}
            type="monotone"
            dataKey={site.id}
            stackId={isSingle ? undefined : "stack"}
            stroke={siteColor(idx)}
            fill={isSingle ? `url(#${gradientId})` : siteColor(idx)}
            fillOpacity={isSingle ? 1 : 0.5}
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4 }}
          />
        ))}
      </AreaChart>
    </ResponsiveContainer>
  );
}
