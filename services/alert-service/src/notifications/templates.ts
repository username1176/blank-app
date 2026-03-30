/**
 * Notification message templates.
 *
 * formatNotification() maps an alert payload to a set of pre-rendered
 * strings consumed by both the email and SMS channels.
 *
 * Design goals:
 *   - Each alert category (environmental, moisture, inventory) gets
 *     actionable, domain-specific language rather than a generic fallback.
 *   - Email bodies include all relevant numeric data from the payload.
 *   - SMS text stays within 160 characters (single segment) for critical
 *     alerts; warning SMS is allowed to spill into two segments.
 *   - Subject lines include [CRITICAL] / [WARNING] prefix for email
 *     clients that display subjects in notification previews.
 */

import { AlertPayload } from "../types/alert";
import { AlertCategory, classifyAlertType } from "./types";

// ---------------------------------------------------------------------------
// Public output
// ---------------------------------------------------------------------------

export interface FormattedNotification {
  subject:  string;
  bodyText: string;
  bodyHtml: string;
  /** Concise text for SMS (aim for ≤ 160 chars on critical). */
  smsText:  string;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function formatNotification(
  payload: AlertPayload,
  source:  string,
): FormattedNotification {
  const category = classifyAlertType(payload.type);
  const severity = payload.severity.toUpperCase();
  const tag      = `[${severity}]`;

  switch (category) {
    case "environmental": return _formatEnvironmental(payload, tag, source);
    case "moisture":      return _formatMoisture(payload, tag, source);
    case "inventory":     return _formatInventory(payload, tag, source);
    default:              return _formatGeneric(payload, tag, source);
  }
}

// ---------------------------------------------------------------------------
// Per-category formatters
// ---------------------------------------------------------------------------

function _formatEnvironmental(
  payload: AlertPayload,
  tag:     string,
  source:  string,
): FormattedNotification {
  const p = payload as Record<string, unknown>;

  const metricLabel = _metricLabel(payload.type);
  const siteLabel   = payload.siteId ? `site ${_short(payload.siteId)}` : "unknown site";
  const sensorLabel = payload.entityId ?? payload.entityType ?? "sensor";

  // Extract numeric details if the producer included them
  const current   = _num(p["currentValue"])   ?? _num(p["current_value"]);
  const mean      = _num(p["baselineMean"])    ?? _num(p["baseline_mean"]);
  const sigma     = _num(p["deviationSigma"])  ?? _num(p["deviation_sigma"]);
  const unit      = _metricUnit(payload.type);

  const valueClause = current !== null && mean !== null
    ? `${current.toFixed(2)}${unit} (baseline ${mean.toFixed(2)}${unit}${sigma !== null ? `, ${sigma.toFixed(1)}σ` : ""})`
    : payload.message;

  const subject = `${tag} ${metricLabel} Alert — ${siteLabel}`;

  const bodyText = [
    `${tag} ${metricLabel} alert detected`,
    "",
    `  Type:     ${payload.type}`,
    `  Severity: ${payload.severity}`,
    `  Site:     ${payload.siteId ?? "—"}`,
    `  Sensor:   ${sensorLabel}`,
    `  Value:    ${valueClause}`,
    `  Detected: ${_formatDate(payload.detectedAt)}`,
    "",
    `Message: ${payload.message}`,
    "",
    "This is an automated alert from the Warehouse Materials Intelligence Platform.",
    `Source: ${source}`,
  ].join("\n");

  const bodyHtml = _wrapHtml(subject, [
    _row("Type",     payload.type),
    _row("Severity", `<strong>${payload.severity}</strong>`),
    _row("Site",     payload.siteId ?? "—"),
    _row("Sensor",   sensorLabel),
    _row("Value",    _escape(valueClause)),
    _row("Detected", _formatDate(payload.detectedAt)),
    "",
    `<p>${_escape(payload.message)}</p>`,
  ], payload.severity, source);

  const smsText = _truncate(
    `${tag} ${metricLabel}: ${valueClause} at ${siteLabel}. Check dashboard.`,
    160,
  );

  return { subject, bodyText, bodyHtml, smsText };
}

function _formatMoisture(
  payload: AlertPayload,
  tag:     string,
  source:  string,
): FormattedNotification {
  const p = payload as Record<string, unknown>;

  const siteLabel = payload.siteId ? `site ${_short(payload.siteId)}` : "unknown site";
  const pileLabel = payload.entityId ?? "unknown pile";

  const moisturePct = _num(p["moisturePct"])    ?? _num(p["moisture_pct"])
                   ?? _num(p["currentValue"])   ?? _num(p["current_value"]);
  const threshold   = _num(p["thresholdPct"])   ?? _num(p["threshold_pct"]);

  const valueClause = moisturePct !== null
    ? `${moisturePct.toFixed(1)}%${threshold !== null ? ` (threshold ${threshold.toFixed(1)}%)` : ""}`
    : payload.message;

  const subject  = `${tag} Moisture Spike — ${siteLabel}`;

  const bodyText = [
    `${tag} Moisture alert detected`,
    "",
    `  Type:     ${payload.type}`,
    `  Severity: ${payload.severity}`,
    `  Site:     ${payload.siteId ?? "—"}`,
    `  Pile:     ${pileLabel}`,
    `  Moisture: ${valueClause}`,
    `  Detected: ${_formatDate(payload.detectedAt)}`,
    "",
    `Message: ${payload.message}`,
    "",
    "This is an automated alert from the Warehouse Materials Intelligence Platform.",
    `Source: ${source}`,
  ].join("\n");

  const bodyHtml = _wrapHtml(subject, [
    _row("Type",     payload.type),
    _row("Severity", `<strong>${payload.severity}</strong>`),
    _row("Site",     payload.siteId ?? "—"),
    _row("Pile",     pileLabel),
    _row("Moisture", _escape(valueClause)),
    _row("Detected", _formatDate(payload.detectedAt)),
    "",
    `<p>${_escape(payload.message)}</p>`,
  ], payload.severity, source);

  const smsText = _truncate(
    `${tag} Moisture: ${valueClause} at pile ${_short(pileLabel)}, ${siteLabel}. Check dashboard.`,
    160,
  );

  return { subject, bodyText, bodyHtml, smsText };
}

function _formatInventory(
  payload: AlertPayload,
  tag:     string,
  source:  string,
): FormattedNotification {
  const p = payload as Record<string, unknown>;

  const siteLabel  = payload.siteId ? `site ${_short(payload.siteId)}` : "unknown site";
  const pileLabel  = payload.entityId ?? "unknown pile";

  const currentVol  = _num(p["currentVolume"])  ?? _num(p["current_volume"])
                   ?? _num(p["currentValue"])   ?? _num(p["current_value"]);
  const previousVol = _num(p["previousVolume"]) ?? _num(p["previous_volume"]);
  const dropPct     = _num(p["dropPercent"])    ?? _num(p["drop_percent"]);
  const unit        = (p["volumeUnit"] as string | undefined) ?? "m³";

  let valueClause: string;
  if (currentVol !== null && previousVol !== null) {
    const drop = previousVol - currentVol;
    valueClause = `${currentVol.toFixed(1)} ${unit} (↓${drop.toFixed(1)} ${unit}${dropPct !== null ? `, ${dropPct.toFixed(1)}% drop` : ""})`;
  } else if (dropPct !== null) {
    valueClause = `${dropPct.toFixed(1)}% volume drop`;
  } else {
    valueClause = payload.message;
  }

  const subject = `${tag} Inventory Drop — ${siteLabel}`;

  const bodyText = [
    `${tag} Pile volume drop detected`,
    "",
    `  Type:     ${payload.type}`,
    `  Severity: ${payload.severity}`,
    `  Site:     ${payload.siteId ?? "—"}`,
    `  Pile:     ${pileLabel}`,
    `  Volume:   ${valueClause}`,
    `  Detected: ${_formatDate(payload.detectedAt)}`,
    "",
    `Message: ${payload.message}`,
    "",
    "This is an automated alert from the Warehouse Materials Intelligence Platform.",
    `Source: ${source}`,
  ].join("\n");

  const bodyHtml = _wrapHtml(subject, [
    _row("Type",     payload.type),
    _row("Severity", `<strong>${payload.severity}</strong>`),
    _row("Site",     payload.siteId ?? "—"),
    _row("Pile",     pileLabel),
    _row("Volume",   _escape(valueClause)),
    _row("Detected", _formatDate(payload.detectedAt)),
    "",
    `<p>${_escape(payload.message)}</p>`,
  ], payload.severity, source);

  const smsText = _truncate(
    `${tag} Inventory: ${valueClause} at pile ${_short(pileLabel)}, ${siteLabel}. Check dashboard.`,
    160,
  );

  return { subject, bodyText, bodyHtml, smsText };
}

function _formatGeneric(
  payload: AlertPayload,
  tag:     string,
  source:  string,
): FormattedNotification {
  const siteLabel = payload.siteId ? `site ${_short(payload.siteId)}` : "unknown site";

  const subject = `${tag} Alert: ${payload.type} — ${siteLabel}`;

  const bodyText = [
    `${tag} Alert detected`,
    "",
    `  Type:     ${payload.type}`,
    `  Severity: ${payload.severity}`,
    `  Site:     ${payload.siteId ?? "—"}`,
    `  Entity:   ${payload.entityId ?? "—"}`,
    `  Detected: ${_formatDate(payload.detectedAt)}`,
    "",
    `Message: ${payload.message}`,
    "",
    "This is an automated alert from the Warehouse Materials Intelligence Platform.",
    `Source: ${source}`,
  ].join("\n");

  const bodyHtml = _wrapHtml(subject, [
    _row("Type",     payload.type),
    _row("Severity", `<strong>${payload.severity}</strong>`),
    _row("Site",     payload.siteId ?? "—"),
    _row("Entity",   payload.entityId ?? "—"),
    _row("Detected", _formatDate(payload.detectedAt)),
    "",
    `<p>${_escape(payload.message)}</p>`,
  ], payload.severity, source);

  const smsText = _truncate(`${tag} ${payload.type} at ${siteLabel}: ${payload.message}`, 160);

  return { subject, bodyText, bodyHtml, smsText };
}

// ---------------------------------------------------------------------------
// HTML email wrapper
// ---------------------------------------------------------------------------

function _wrapHtml(
  title:    string,
  rows:     string[],
  severity: string,
  source:   string,
): string {
  const borderColor = severity === "critical" ? "#d9534f" : "#f0ad4e";
  const badge       = severity === "critical"
    ? `<span style="background:#d9534f;color:#fff;padding:2px 8px;border-radius:3px;font-size:12px;font-weight:bold;text-transform:uppercase">CRITICAL</span>`
    : `<span style="background:#f0ad4e;color:#fff;padding:2px 8px;border-radius:3px;font-size:12px;font-weight:bold;text-transform:uppercase">WARNING</span>`;

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:24px 0">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0"
             style="background:#fff;border-radius:6px;border-top:4px solid ${borderColor};
                    box-shadow:0 1px 4px rgba(0,0,0,.12);overflow:hidden">
        <tr>
          <td style="padding:24px 32px;border-bottom:1px solid #eee">
            <p style="margin:0;font-size:11px;color:#888;text-transform:uppercase;letter-spacing:.05em">
              Warehouse Materials Intelligence Platform
            </p>
            <h1 style="margin:8px 0 12px;font-size:20px;color:#1a1a1a">${_escape(title)}</h1>
            ${badge}
          </td>
        </tr>
        <tr>
          <td style="padding:24px 32px">
            <table width="100%" cellpadding="6" cellspacing="0"
                   style="border-collapse:collapse;font-size:14px;color:#333">
              ${rows.filter((r) => r !== "").join("\n              ")}
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding:16px 32px;background:#f9f9f9;border-top:1px solid #eee;
                     font-size:11px;color:#888;text-align:center">
            This is an automated alert generated by <strong>${_escape(source)}</strong>.
            Do not reply to this message.
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function _row(label: string, value: string): string {
  return `<tr style="border-bottom:1px solid #f0f0f0">
              <td style="width:100px;font-weight:bold;color:#555;white-space:nowrap">${_escape(label)}</td>
              <td>${value}</td>
            </tr>`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function _metricLabel(alertType: string): string {
  if (alertType.startsWith("temperature")) return "Temperature";
  if (alertType.startsWith("humidity"))    return "Humidity";
  if (alertType.startsWith("pressure"))    return "Pressure";
  if (alertType.startsWith("co2"))         return "CO₂";
  return "Environmental";
}

function _metricUnit(alertType: string): string {
  if (alertType.startsWith("temperature")) return "°C";
  if (alertType.startsWith("humidity"))    return "% RH";
  if (alertType.startsWith("pressure"))    return " hPa";
  if (alertType.startsWith("co2"))         return " ppm";
  return "";
}

function _num(v: unknown): number | null {
  if (typeof v === "number" && isFinite(v)) return v;
  if (typeof v === "string") {
    const n = parseFloat(v);
    return isFinite(n) ? n : null;
  }
  return null;
}

/** Return the first 8 chars of a UUID or identifier for compact display. */
function _short(id: string): string {
  return id.length > 8 ? id.slice(0, 8) + "…" : id;
}

function _formatDate(iso: string): string {
  try {
    return new Date(iso).toUTCString();
  } catch {
    return iso;
  }
}

function _escape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function _truncate(s: string, maxLen: number): string {
  return s.length <= maxLen ? s : s.slice(0, maxLen - 1) + "…";
}
