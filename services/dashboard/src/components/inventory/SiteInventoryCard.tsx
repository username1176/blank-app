/**
 * SiteInventoryCard — shows a single site's current inventory snapshot.
 *
 * • One horizontal bar per material type, sized relative to the site maximum.
 * • Material bar color is derived deterministically from the material name so
 *   the same material always gets the same hue regardless of ordering.
 * • Border/background turns red for critical alerts, amber for warning.
 * • A selected-state blue ring is drawn when `isSelected` is true.
 */

import { useMemo }                  from "react";
import type { Site, InventoryItem, Alert, AlertSeverity } from "../../types";

// ── Color palette ──────────────────────────────────────────────────────────────

const BAR_COLORS = [
  "bg-blue-500",
  "bg-violet-500",
  "bg-emerald-500",
  "bg-orange-500",
  "bg-pink-500",
  "bg-cyan-500",
  "bg-amber-500",
  "bg-teal-500",
];

function materialColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  }
  return BAR_COLORS[hash % BAR_COLORS.length]!;
}

// ── Severity helpers ──────────────────────────────────────────────────────────

const SEVERITY_RANK: Record<AlertSeverity, number> = { critical: 2, warning: 1, info: 0 };

function worstSeverity(alerts: Alert[]): AlertSeverity | null {
  if (alerts.length === 0) return null;
  return alerts.reduce<Alert>(
    (best, a) => (SEVERITY_RANK[a.severity] > SEVERITY_RANK[best.severity] ? a : best),
    alerts[0]!,
  ).severity;
}

// ── Relative time ─────────────────────────────────────────────────────────────

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins  = Math.floor(diff / 60_000);
  if (mins < 2)   return "just now";
  if (mins < 60)  return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs  < 24)  return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

// ── Component ─────────────────────────────────────────────────────────────────

interface Props {
  site:       Site;
  items:      InventoryItem[];
  alerts:     Alert[];
  isSelected: boolean;
  onClick:    () => void;
}

export default function SiteInventoryCard({ site, items, alerts, isSelected, onClick }: Props) {
  const severity = worstSeverity(alerts);

  const maxVolume = useMemo(
    () => Math.max(...items.map((i) => i.estimatedVolumeCubicM), 1),
    [items],
  );

  const totalVolume = useMemo(
    () => items.reduce((sum, i) => sum + i.estimatedVolumeCubicM, 0),
    [items],
  );

  const totalPiles = useMemo(
    () => items.reduce((sum, i) => sum + i.pileCount, 0),
    [items],
  );

  const latestUpdate = useMemo(() => {
    if (items.length === 0) return null;
    return items.reduce((latest, i) =>
      i.lastUpdatedAt > latest ? i.lastUpdatedAt : latest,
      items[0]!.lastUpdatedAt,
    );
  }, [items]);

  // Card border style based on anomaly severity and selection state.
  let borderClass = "border-slate-200";
  let bgClass     = "bg-white";
  if (severity === "critical") { borderClass = "border-red-400";   bgClass = "bg-red-50"; }
  else if (severity === "warning") { borderClass = "border-amber-400"; bgClass = "bg-amber-50"; }

  const ringClass = isSelected ? "ring-2 ring-blue-500 ring-offset-1" : "";

  return (
    <button
      onClick={onClick}
      className={`w-full text-left rounded-xl border ${borderClass} ${bgClass} ${ringClass}
                  shadow-sm p-4 space-y-3 transition-all hover:shadow-md focus:outline-none`}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-slate-800 truncate">{site.name}</p>
          {site.location.address && (
            <p className="text-xs text-slate-400 truncate mt-0.5">{site.location.address}</p>
          )}
        </div>

        {/* Anomaly badge */}
        {severity === "critical" && (
          <span className="shrink-0 text-xs font-medium bg-red-100 text-red-700 px-2 py-0.5 rounded-full">
            Critical
          </span>
        )}
        {severity === "warning" && (
          <span className="shrink-0 text-xs font-medium bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full">
            Warning
          </span>
        )}
      </div>

      {/* Summary numbers */}
      <div className="flex items-center gap-4 text-xs text-slate-500">
        <span>
          <span className="text-slate-800 font-semibold tabular-nums">
            {totalVolume >= 1000
              ? `${(totalVolume / 1000).toFixed(1)}k`
              : totalVolume.toFixed(0)}
          </span>{" "}
          m³
        </span>
        <span>
          <span className="text-slate-800 font-semibold tabular-nums">{totalPiles}</span>{" "}
          pile{totalPiles !== 1 ? "s" : ""}
        </span>
        <span>
          <span className="text-slate-800 font-semibold tabular-nums">{items.length}</span>{" "}
          material{items.length !== 1 ? "s" : ""}
        </span>
      </div>

      {/* Material bars */}
      {items.length > 0 ? (
        <div className="space-y-1.5">
          {items.slice(0, 5).map((item) => {
            const pct = (item.estimatedVolumeCubicM / maxVolume) * 100;
            return (
              <div key={item.id}>
                <div className="flex justify-between text-xs text-slate-500 mb-0.5">
                  <span className="truncate max-w-[60%]">{item.materialType}</span>
                  <span className="tabular-nums">{item.estimatedVolumeCubicM.toFixed(0)} m³</span>
                </div>
                <div className="h-1.5 rounded-full bg-slate-200 overflow-hidden">
                  <div
                    className={`h-full rounded-full ${materialColor(item.materialType)} transition-all`}
                    style={{ width: `${pct}%` }}
                  />
                </div>
              </div>
            );
          })}
          {items.length > 5 && (
            <p className="text-xs text-slate-400">+{items.length - 5} more material types</p>
          )}
        </div>
      ) : (
        <p className="text-xs text-slate-400 italic">No inventory data</p>
      )}

      {/* Footer */}
      {latestUpdate && (
        <p className="text-xs text-slate-400">Updated {relativeTime(latestUpdate)}</p>
      )}
    </button>
  );
}
