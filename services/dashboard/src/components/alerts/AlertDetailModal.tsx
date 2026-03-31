/**
 * AlertDetailModal — full-detail view for a single alert.
 *
 * Shows:
 *   • Type, severity, status, site, and full message
 *   • Three-step timeline: Created → Acknowledged → Resolved
 *   • Acknowledge (if open) and Resolve (if open/acknowledged) buttons
 *
 * Closes on backdrop click or Escape key.
 */

import { useEffect, useRef } from "react";
import { SeverityBadge, StatusBadge } from "../ui/Badge";
import type { Alert, AlertSeverity, AlertStatus } from "../../types";

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(iso: string | undefined): string {
  if (!iso) return "";
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

const SEVERITY_ICON: Record<AlertSeverity, { icon: string; bg: string; text: string }> = {
  info:     { icon: "ℹ",  bg: "bg-blue-100",  text: "text-blue-600"  },
  warning:  { icon: "⚠",  bg: "bg-amber-100", text: "text-amber-600" },
  critical: { icon: "✕",  bg: "bg-red-100",   text: "text-red-600"   },
};

// ── Timeline ──────────────────────────────────────────────────────────────────

interface TimelineStep {
  label:    string;
  sublabel: string;
  done:     boolean;
  active:   boolean;
}

function Timeline({ steps }: { steps: TimelineStep[] }) {
  return (
    <ol className="flex items-start gap-0">
      {steps.map((step, i) => {
        const isLast = i === steps.length - 1;
        return (
          <li key={step.label} className="flex-1 flex flex-col items-center">
            <div className="flex items-center w-full">
              {/* Left connector */}
              <div className={`flex-1 h-0.5 ${i === 0 ? "opacity-0" : step.done ? "bg-blue-500" : "bg-slate-200"}`} />

              {/* Node */}
              <div className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 border-2 transition-colors
                ${step.done
                  ? "bg-blue-500 border-blue-500"
                  : step.active
                    ? "bg-white border-blue-500"
                    : "bg-white border-slate-200"
                }`}
              >
                {step.done ? (
                  <svg className="w-3.5 h-3.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                ) : (
                  <span className={`w-2 h-2 rounded-full ${step.active ? "bg-blue-500" : "bg-slate-300"}`} />
                )}
              </div>

              {/* Right connector */}
              <div className={`flex-1 h-0.5 ${isLast ? "opacity-0" : step.done && steps[i + 1]?.done ? "bg-blue-500" : "bg-slate-200"}`} />
            </div>

            {/* Label */}
            <div className="mt-2 text-center px-1">
              <p className={`text-xs font-semibold ${step.done ? "text-slate-800" : "text-slate-400"}`}>
                {step.label}
              </p>
              {step.sublabel && (
                <p className="text-xs text-slate-400 mt-0.5 leading-tight">{step.sublabel}</p>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

// ── Props & component ─────────────────────────────────────────────────────────

interface Props {
  alert:            Alert;
  siteMap:          Record<string, string>;
  onClose:          () => void;
  onAcknowledge:    (id: string) => void;
  onResolve:        (id: string) => void;
  isAcknowledging:  boolean;
  isResolving:      boolean;
}

export default function AlertDetailModal({
  alert,
  siteMap,
  onClose,
  onAcknowledge,
  onResolve,
  isAcknowledging,
  isResolving,
}: Props) {
  const panelRef = useRef<HTMLDivElement>(null);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  // Focus panel on mount for keyboard accessibility
  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  const icon = SEVERITY_ICON[alert.severity];

  const timelineSteps: TimelineStep[] = [
    {
      label:    "Created",
      sublabel: fmt(alert.createdAt),
      done:     true,
      active:   false,
    },
    {
      label:    "Acknowledged",
      sublabel: alert.acknowledgedAt
        ? fmt(alert.acknowledgedAt) + (alert.acknowledgedBy ? ` by ${alert.acknowledgedBy}` : "")
        : "",
      done:   !!alert.acknowledgedAt,
      active: alert.status === "open",
    },
    {
      label:    "Resolved",
      sublabel: alert.resolvedAt ? fmt(alert.resolvedAt) : "",
      done:     !!alert.resolvedAt,
      active:   alert.status === "acknowledged",
    },
  ];

  const canAcknowledge = alert.status === "open";
  const canResolve     = alert.status === "open" || alert.status === "acknowledged";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="modal-title"
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Panel */}
      <div
        ref={panelRef}
        tabIndex={-1}
        className="relative z-10 w-full max-w-xl bg-white rounded-2xl shadow-2xl
                   outline-none overflow-hidden flex flex-col max-h-[90vh]"
      >
        {/* Header */}
        <div className="flex items-start gap-4 px-6 pt-6 pb-4 border-b border-slate-100">
          <div className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 text-lg ${icon.bg} ${icon.text}`}>
            {icon.icon}
          </div>

          <div className="flex-1 min-w-0">
            <div className="flex flex-wrap items-center gap-2 mb-1">
              <h2 id="modal-title" className="text-base font-bold text-slate-900 truncate">
                {alert.type}
              </h2>
              <SeverityBadge severity={alert.severity as AlertSeverity} />
              <StatusBadge   status={alert.status   as AlertStatus}   />
            </div>
            <p className="text-xs text-slate-400">
              {siteMap[alert.siteId] ?? alert.siteId}
              <span className="mx-1.5">·</span>
              ID: <span className="font-mono">{alert.id}</span>
            </p>
          </div>

          <button
            onClick={onClose}
            aria-label="Close"
            className="shrink-0 p-1.5 rounded-lg text-slate-400 hover:text-slate-600
                       hover:bg-slate-100 transition-colors"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="px-6 py-5 overflow-y-auto space-y-6">
          {/* Message */}
          <div>
            <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-1.5">Message</p>
            <p className="text-sm text-slate-700 leading-relaxed bg-slate-50 rounded-lg px-4 py-3 border border-slate-100">
              {alert.message}
            </p>
          </div>

          {/* Metadata grid */}
          <div className="grid grid-cols-2 gap-x-8 gap-y-3">
            {[
              { label: "Site",     value: siteMap[alert.siteId] ?? alert.siteId },
              { label: "Type",     value: alert.type },
              { label: "Severity", value: alert.severity.charAt(0).toUpperCase() + alert.severity.slice(1) },
              { label: "Status",   value: alert.status.charAt(0).toUpperCase()   + alert.status.slice(1)   },
              { label: "Created",  value: fmt(alert.createdAt) },
              ...(alert.acknowledgedAt ? [{ label: "Acknowledged", value: fmt(alert.acknowledgedAt) }] : []),
              ...(alert.acknowledgedBy ? [{ label: "Acknowledged by", value: alert.acknowledgedBy }]   : []),
              ...(alert.resolvedAt     ? [{ label: "Resolved", value: fmt(alert.resolvedAt) }]         : []),
            ].map(({ label, value }) => (
              <div key={label}>
                <p className="text-xs text-slate-400 font-medium">{label}</p>
                <p className="text-sm text-slate-800 mt-0.5">{value}</p>
              </div>
            ))}
          </div>

          {/* Timeline */}
          <div>
            <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-4">Timeline</p>
            <Timeline steps={timelineSteps} />
          </div>
        </div>

        {/* Footer actions */}
        {(canAcknowledge || canResolve) && (
          <div className="px-6 py-4 border-t border-slate-100 flex items-center justify-end gap-3 bg-slate-50">
            {canAcknowledge && (
              <button
                onClick={() => onAcknowledge(alert.id)}
                disabled={isAcknowledging || isResolving}
                className="px-4 py-2 text-sm font-semibold rounded-lg border border-amber-300
                           text-amber-700 bg-amber-50 hover:bg-amber-100 disabled:opacity-50
                           transition-colors"
              >
                {isAcknowledging ? "Acknowledging…" : "Acknowledge"}
              </button>
            )}
            {canResolve && (
              <button
                onClick={() => onResolve(alert.id)}
                disabled={isAcknowledging || isResolving}
                className="px-4 py-2 text-sm font-semibold rounded-lg
                           text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50
                           transition-colors shadow-sm"
              >
                {isResolving ? "Resolving…" : "Mark resolved"}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
