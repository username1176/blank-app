/**
 * MoistureHeatmap — SVG grid floor-plan showing real-time moisture predictions.
 *
 * Colour scale:
 *   Green  (0 – 15 %)  → dry
 *   Yellow (15 – 25 %) → normal
 *   Red    (25 %+)     → wet
 *
 * Zones are fetched once (staleTime 5 min).
 * Predictions are polled every 30 s.
 * A rich tooltip appears on hover showing moisture %, confidence, source, and
 * last update time.
 */

import { useMemo, useRef, useState, useCallback } from "react";
import { useQuery }                                from "@tanstack/react-query";
import { fetchPileZones, fetchMoisturePredictions } from "../../api/moisture";
import type { PileZone, MoisturePrediction }        from "../../types";

// ── Constants ─────────────────────────────────────────────────────────────────

const CELL_PX   = 72;   // grid cell size in pixels
const PAD_PX    = 28;   // outer SVG padding
const CORNER_R  = 6;    // zone rectangle corner radius
const LEGEND_H  = 36;   // colour-scale legend strip height
const POLL_MS   = 30_000;

// ── Colour helpers ────────────────────────────────────────────────────────────

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace("#", ""), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function lerpColor(a: string, b: string, t: number): string {
  const [ar, ag, ab] = hexToRgb(a);
  const [br, bg, bb] = hexToRgb(b);
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const b2 = Math.round(ab + (bb - ab) * t);
  return `rgb(${r},${g},${b2})`;
}

// Anchor colours at key moisture breakpoints
const STOPS: Array<{ pct: number; hex: string }> = [
  { pct: 0,   hex: "#15803d" },  // green-700  — bone dry
  { pct: 12,  hex: "#22c55e" },  // green-500
  { pct: 18,  hex: "#eab308" },  // yellow-500
  { pct: 25,  hex: "#f97316" },  // orange-500
  { pct: 35,  hex: "#dc2626" },  // red-600    — very wet
  { pct: 50,  hex: "#7f1d1d" },  // red-900
];

function moistureColor(pct: number): string {
  const clamped = Math.max(0, pct);
  for (let i = 1; i < STOPS.length; i++) {
    const prev = STOPS[i - 1]!;
    const curr = STOPS[i]!;
    if (clamped <= curr.pct) {
      const t = (clamped - prev.pct) / (curr.pct - prev.pct);
      return lerpColor(prev.hex, curr.hex, t);
    }
  }
  return STOPS[STOPS.length - 1]!.hex;
}

// Text contrast: dark label on bright fills, white on dark ones
function labelColor(pct: number): string {
  return pct < 20 ? "#14532d" : pct < 30 ? "#451a03" : "#ffffff";
}

// ── Classification label ──────────────────────────────────────────────────────

function classifyMoisture(pct: number): { label: string; color: string } {
  if (pct < 15) return { label: "Dry",    color: "text-green-700"  };
  if (pct < 25) return { label: "Normal", color: "text-yellow-700" };
  return              { label: "Wet",     color: "text-red-700"    };
}

// ── Confidence badge ──────────────────────────────────────────────────────────

function confidenceLabel(score: number): { text: string; color: string } {
  if (score >= 0.85) return { text: "High",   color: "text-emerald-700 bg-emerald-50" };
  if (score >= 0.60) return { text: "Medium", color: "text-amber-700   bg-amber-50"   };
  return                    { text: "Low",    color: "text-red-700     bg-red-50"     };
}

// ── Relative time ─────────────────────────────────────────────────────────────

function relTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60)  return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60)  return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

// ── Tooltip ───────────────────────────────────────────────────────────────────

interface TooltipData {
  x:          number;
  y:          number;
  zone:       PileZone;
  prediction: MoisturePrediction | null;
}

function Tooltip({ data, containerW, containerH }: {
  data:       TooltipData;
  containerW: number;
  containerH: number;
}) {
  const W = 220;
  const H = 148;
  const OFFSET = 14;

  // Flip horizontally if too close to right edge
  const left = data.x + OFFSET + W > containerW
    ? data.x - OFFSET - W
    : data.x + OFFSET;

  // Flip vertically if too close to bottom edge
  const top = data.y + OFFSET + H > containerH
    ? data.y - OFFSET - H
    : data.y + OFFSET;

  const { zone, prediction } = data;

  if (!prediction) {
    return (
      <div
        className="absolute z-50 pointer-events-none rounded-xl shadow-lg border border-slate-200 bg-white p-3"
        style={{ left, top, width: W }}
      >
        <p className="text-xs font-semibold text-slate-800">{zone.label}</p>
        <p className="text-xs text-slate-400 mt-1">No prediction data available.</p>
      </div>
    );
  }

  const cls  = classifyMoisture(prediction.moisturePercent);
  const conf = confidenceLabel(prediction.confidenceScore);

  return (
    <div
      className="absolute z-50 pointer-events-none rounded-xl shadow-xl border border-slate-200 bg-white p-3 space-y-2"
      style={{ left, top, width: W }}
    >
      {/* Zone name */}
      <p className="text-xs font-bold text-slate-800 leading-tight">{zone.label}</p>

      {/* Moisture */}
      <div className="flex items-center justify-between">
        <span className="text-slate-500 text-xs">Moisture</span>
        <div className="flex items-center gap-1.5">
          <span className="text-sm font-bold text-slate-800 tabular-nums">
            {prediction.moisturePercent.toFixed(1)}%
          </span>
          <span className={`text-xs font-semibold ${cls.color}`}>{cls.label}</span>
        </div>
      </div>

      {/* Confidence */}
      <div className="flex items-center justify-between">
        <span className="text-slate-500 text-xs">Confidence</span>
        <span className={`text-xs font-medium px-1.5 py-0.5 rounded ${conf.color}`}>
          {conf.text} ({Math.round(prediction.confidenceScore * 100)}%)
        </span>
      </div>

      {/* Source */}
      <div className="flex items-center justify-between">
        <span className="text-slate-500 text-xs">Source</span>
        <span className="text-xs text-slate-600 capitalize">
          {prediction.source.replace(/_/g, " ")}
        </span>
      </div>

      {/* Time */}
      <div className="flex items-center justify-between pt-1 border-t border-slate-100">
        <span className="text-slate-400 text-xs">Updated</span>
        <span className="text-xs text-slate-400">{relTime(prediction.predictedAt)}</span>
      </div>
    </div>
  );
}

// ── Colour scale legend ───────────────────────────────────────────────────────

function ColourLegend({ width }: { width: number }) {
  const gradientId = "heatmap-legend-gradient";
  const stops = STOPS.map((s) => ({
    offset: `${(s.pct / 50) * 100}%`,
    color:  s.hex,
  }));

  return (
    <div className="mt-4 select-none">
      <svg width={width} height={LEGEND_H}>
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="0">
            {stops.map((s) => (
              <stop key={s.offset} offset={s.offset} stopColor={s.color} />
            ))}
          </linearGradient>
        </defs>
        {/* gradient bar */}
        <rect x={PAD_PX} y={0} width={width - PAD_PX * 2} height={14} rx={7}
              fill={`url(#${gradientId})`} />
        {/* tick labels */}
        {[
          { pct: 0,  label: "0%" },
          { pct: 15, label: "15%" },
          { pct: 25, label: "25%" },
          { pct: 50, label: "≥50%" },
        ].map(({ pct, label }) => {
          const x = PAD_PX + ((pct / 50) * (width - PAD_PX * 2));
          return (
            <text key={pct} x={x} y={30} textAnchor="middle"
                  fontSize={10} fill="#94a3b8">{label}</text>
          );
        })}
        {/* category labels */}
        {[
          { pct: 7.5,  text: "Dry",    fill: "#15803d" },
          { pct: 20,   text: "Normal", fill: "#a16207" },
          { pct: 37.5, text: "Wet",    fill: "#b91c1c" },
        ].map(({ pct, text, fill }) => (
          <text key={text}
                x={PAD_PX + ((pct / 50) * (width - PAD_PX * 2))}
                y={10} textAnchor="middle" fontSize={9} fontWeight="600" fill={fill}>
            {text}
          </text>
        ))}
      </svg>
    </div>
  );
}

// ── Empty state ───────────────────────────────────────────────────────────────

function EmptyState({ isLoading }: { isLoading: boolean }) {
  return (
    <div className="flex flex-col items-center justify-center h-56 text-slate-400 gap-2">
      {isLoading ? (
        <>
          <svg className="animate-spin w-6 h-6 text-blue-400" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
          </svg>
          <span className="text-sm">Loading floor plan…</span>
        </>
      ) : (
        <>
          <svg className="w-10 h-10 text-slate-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1}>
            <path strokeLinecap="round" strokeLinejoin="round"
              d="M9 20.5H5a2 2 0 01-2-2V5a2 2 0 012-2h14a2 2 0 012 2v6M9 20.5l6-6m0 0l3 3m-3-3v6" />
          </svg>
          <p className="text-sm">No pile zones configured for this site.</p>
          <p className="text-xs text-slate-300">Zones are defined in the site management settings.</p>
        </>
      )}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

interface Props {
  siteId: string;
}

export default function MoistureHeatmap({ siteId }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [tooltip, setTooltip] = useState<TooltipData | null>(null);
  const [containerSize, setContainerSize] = useState({ w: 800, h: 400 });

  // ── Data queries ───────────────────────────────────────────────────────────

  const zonesQuery = useQuery({
    queryKey:  ["pile-zones", siteId],
    queryFn:   () => fetchPileZones(siteId),
    enabled:   !!siteId,
    staleTime: 5 * 60_000,
  });

  const predQuery = useQuery({
    queryKey:        ["moisture-predictions", siteId],
    queryFn:         () => fetchMoisturePredictions(siteId),
    enabled:         !!siteId,
    refetchInterval: POLL_MS,
  });

  const zones   = zonesQuery.data ?? [];
  const predMap = useMemo(() => {
    const m = new Map<string, MoisturePrediction>();
    for (const p of predQuery.data ?? []) m.set(p.zoneId, p);
    return m;
  }, [predQuery.data]);

  // ── SVG geometry ───────────────────────────────────────────────────────────

  const { gridCols, gridRows } = useMemo(() => {
    let gridCols = 0, gridRows = 0;
    for (const z of zones) {
      gridCols = Math.max(gridCols, z.col + (z.width  ?? 1));
      gridRows = Math.max(gridRows, z.row + (z.height ?? 1));
    }
    return { gridCols: Math.max(gridCols, 1), gridRows: Math.max(gridRows, 1) };
  }, [zones]);

  const svgW = gridCols * CELL_PX + PAD_PX * 2;
  const svgH = gridRows * CELL_PX + PAD_PX * 2;

  // ── Mouse handlers ─────────────────────────────────────────────────────────

  const updateContainerSize = useCallback(() => {
    const el = containerRef.current;
    if (el) setContainerSize({ w: el.offsetWidth, h: el.offsetHeight });
  }, []);

  const handleMouseEnter = useCallback(
    (e: React.MouseEvent, zone: PileZone) => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      setTooltip({
        x:          e.clientX - rect.left,
        y:          e.clientY - rect.top,
        zone,
        prediction: predMap.get(zone.id) ?? null,
      });
    },
    [predMap],
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!tooltip) return;
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      setTooltip((t) =>
        t ? { ...t, x: e.clientX - rect.left, y: e.clientY - rect.top } : null,
      );
    },
    [tooltip],
  );

  const handleMouseLeave = useCallback(() => setTooltip(null), []);

  // ── Polling indicator ──────────────────────────────────────────────────────

  const lastUpdated = predQuery.dataUpdatedAt
    ? new Date(predQuery.dataUpdatedAt).toLocaleTimeString()
    : null;

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-1">
      {/* Header row */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-slate-700">Pile Zone Heatmap</h3>
          {predQuery.isFetching && (
            <span className="text-xs text-blue-500 animate-pulse">Updating…</span>
          )}
        </div>
        {lastUpdated && (
          <span className="text-xs text-slate-400">Last updated {lastUpdated}</span>
        )}
      </div>

      {/* Map area */}
      <div
        ref={containerRef}
        className="relative bg-slate-50 border border-slate-200 rounded-xl overflow-auto"
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
        onMouseEnter={updateContainerSize}
      >
        {zones.length === 0 ? (
          <EmptyState isLoading={zonesQuery.isLoading} />
        ) : (
          <svg
            width={svgW}
            height={svgH}
            viewBox={`0 0 ${svgW} ${svgH}`}
            className="block"
            aria-label="Warehouse moisture heatmap"
          >
            {/* Background grid lines */}
            <g stroke="#e2e8f0" strokeWidth={0.5}>
              {Array.from({ length: gridCols + 1 }, (_, i) => (
                <line
                  key={`v${i}`}
                  x1={PAD_PX + i * CELL_PX} y1={PAD_PX}
                  x2={PAD_PX + i * CELL_PX} y2={PAD_PX + gridRows * CELL_PX}
                />
              ))}
              {Array.from({ length: gridRows + 1 }, (_, i) => (
                <line
                  key={`h${i}`}
                  x1={PAD_PX} y1={PAD_PX + i * CELL_PX}
                  x2={PAD_PX + gridCols * CELL_PX} y2={PAD_PX + i * CELL_PX}
                />
              ))}
            </g>

            {/* Zone rectangles */}
            {zones.map((zone) => {
              const zw  = (zone.width  ?? 1) * CELL_PX;
              const zh  = (zone.height ?? 1) * CELL_PX;
              const x   = PAD_PX + zone.col * CELL_PX;
              const y   = PAD_PX + zone.row * CELL_PX;
              const pred = predMap.get(zone.id);
              const fill = pred ? moistureColor(pred.moisturePercent) : "#e2e8f0";
              const textFill = pred ? labelColor(pred.moisturePercent) : "#94a3b8";
              const INSET = 3;

              return (
                <g
                  key={zone.id}
                  className="cursor-pointer"
                  onMouseEnter={(e) => handleMouseEnter(e, zone)}
                >
                  {/* Zone fill */}
                  <rect
                    x={x + INSET} y={y + INSET}
                    width={zw - INSET * 2} height={zh - INSET * 2}
                    rx={CORNER_R} ry={CORNER_R}
                    fill={fill}
                    opacity={pred ? 0.88 : 0.4}
                    className="transition-opacity duration-300 hover:opacity-100"
                  />

                  {/* Low-confidence hatching overlay */}
                  {pred && pred.confidenceScore < 0.6 && (
                    <rect
                      x={x + INSET} y={y + INSET}
                      width={zw - INSET * 2} height={zh - INSET * 2}
                      rx={CORNER_R} ry={CORNER_R}
                      fill="url(#lowConfidencePattern)"
                      opacity={0.25}
                    />
                  )}

                  {/* Zone label */}
                  <text
                    x={x + zw / 2} y={y + zh / 2 - (pred ? 6 : 0)}
                    textAnchor="middle" dominantBaseline="middle"
                    fontSize={Math.min(13, (zw - 8) / zone.label.length * 1.4)}
                    fontWeight="600" fill={textFill}
                    className="pointer-events-none select-none"
                  >
                    {zone.label}
                  </text>

                  {/* Moisture % under label */}
                  {pred && (
                    <text
                      x={x + zw / 2} y={y + zh / 2 + 9}
                      textAnchor="middle" dominantBaseline="middle"
                      fontSize={10} fill={textFill} opacity={0.85}
                      className="pointer-events-none select-none tabular-nums"
                    >
                      {pred.moisturePercent.toFixed(1)}%
                    </text>
                  )}

                  {/* No-data placeholder */}
                  {!pred && (
                    <text
                      x={x + zw / 2} y={y + zh / 2 + 10}
                      textAnchor="middle" dominantBaseline="middle"
                      fontSize={9} fill="#94a3b8"
                      className="pointer-events-none select-none"
                    >
                      —
                    </text>
                  )}
                </g>
              );
            })}

            {/* Low-confidence crosshatch pattern def */}
            <defs>
              <pattern id="lowConfidencePattern" patternUnits="userSpaceOnUse"
                       width={8} height={8} patternTransform="rotate(45)">
                <line x1={0} y1={0} x2={0} y2={8} stroke="#000" strokeWidth={2} />
              </pattern>
            </defs>
          </svg>
        )}

        {/* Hover tooltip */}
        {tooltip && (
          <Tooltip
            data={tooltip}
            containerW={containerSize.w}
            containerH={containerSize.h}
          />
        )}
      </div>

      {/* Colour scale legend */}
      {zones.length > 0 && <ColourLegend width={Math.min(svgW, 600)} />}

      {/* Legend note for hatching */}
      {zones.length > 0 && (
        <p className="text-xs text-slate-400 flex items-center gap-1">
          <svg width={14} height={14} className="shrink-0">
            <rect width={14} height={14} rx={2} fill="#94a3b8" opacity={0.25}/>
            <line x1={0} y1={0} x2={14} y2={14} stroke="#475569" strokeWidth={1.5}/>
            <line x1={7} y1={0} x2={14} y2={7} stroke="#475569" strokeWidth={1.5}/>
            <line x1={0} y1={7} x2={7} y2={14} stroke="#475569" strokeWidth={1.5}/>
          </svg>
          Hatched zones have low prediction confidence (&lt; 60%)
        </p>
      )}
    </div>
  );
}
