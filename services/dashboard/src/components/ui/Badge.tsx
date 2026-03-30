import type { AlertSeverity, AlertStatus, SiteStatus } from "../../types";

// ── Alert severity badge ───────────────────────────────────────────────────────

const severityStyles: Record<AlertSeverity, string> = {
  info:     "bg-blue-50 text-blue-700 ring-blue-600/20",
  warning:  "bg-amber-50 text-amber-700 ring-amber-600/20",
  critical: "bg-red-50 text-red-700 ring-red-600/20",
};

export function SeverityBadge({ severity }: { severity: AlertSeverity }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${severityStyles[severity]}`}>
      {severity.charAt(0).toUpperCase() + severity.slice(1)}
    </span>
  );
}

// ── Alert status badge ─────────────────────────────────────────────────────────

const statusStyles: Record<AlertStatus, string> = {
  open:         "bg-red-50 text-red-700 ring-red-600/20",
  acknowledged: "bg-amber-50 text-amber-700 ring-amber-600/20",
  resolved:     "bg-green-50 text-green-700 ring-green-600/20",
};

export function StatusBadge({ status }: { status: AlertStatus }) {
  const label = status.charAt(0).toUpperCase() + status.slice(1);
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${statusStyles[status]}`}>
      {label}
    </span>
  );
}

// ── Site status badge ──────────────────────────────────────────────────────────

const siteStatusStyles: Record<SiteStatus, string> = {
  active:   "bg-green-50 text-green-700 ring-green-600/20",
  warning:  "bg-amber-50 text-amber-700 ring-amber-600/20",
  inactive: "bg-slate-100 text-slate-600 ring-slate-500/20",
};

const siteStatusDot: Record<SiteStatus, string> = {
  active:   "bg-green-500",
  warning:  "bg-amber-500",
  inactive: "bg-slate-400",
};

export function SiteStatusBadge({ status }: { status: SiteStatus }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${siteStatusStyles[status]}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${siteStatusDot[status]}`} />
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </span>
  );
}
