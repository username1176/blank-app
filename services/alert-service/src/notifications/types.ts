/**
 * Shared types for the notification subsystem.
 *
 * Notification preferences are stored per-customer in the DB.  Each row
 * describes one contact (name + email + phone) with per-severity channel
 * selection and optional alert-type / site filters.
 *
 * Expected DB schema:
 *
 *   CREATE TABLE customer_notification_preferences (
 *     id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
 *     customer_id       UUID        NOT NULL,
 *     contact_name      TEXT        NOT NULL,
 *     contact_email     TEXT,
 *     contact_phone     TEXT,          -- E.164 format (+15551234567)
 *     -- [] means "don't notify for this severity"; NULL column not used
 *     channels_warning  TEXT[]      NOT NULL DEFAULT ARRAY['email']::TEXT[],
 *     channels_critical TEXT[]      NOT NULL DEFAULT ARRAY['email','sms']::TEXT[],
 *     -- NULL = subscribe to all; non-null = only listed values
 *     alert_type_filter TEXT[],
 *     site_id_filter    UUID[],
 *     enabled           BOOLEAN     NOT NULL DEFAULT TRUE,
 *     created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 *     updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
 *   );
 *
 *   CREATE INDEX ON customer_notification_preferences (customer_id, enabled);
 *
 *
 *   CREATE TABLE notification_log (
 *     id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
 *     sent_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 *     alert_id      UUID        NOT NULL,
 *     customer_id   UUID        NOT NULL,
 *     preference_id UUID        NOT NULL,
 *     contact_name  TEXT        NOT NULL,
 *     channel       TEXT        NOT NULL CHECK (channel IN ('email','sms')),
 *     recipient     TEXT        NOT NULL,
 *     status        TEXT        NOT NULL CHECK (status IN ('sent','failed','skipped')),
 *     provider_id   TEXT,          -- SendGrid message ID or Twilio SID
 *     error_message TEXT,
 *     UNIQUE (alert_id, preference_id, channel)
 *   );
 *
 *   CREATE INDEX ON notification_log (customer_id, sent_at DESC);
 *   CREATE INDEX ON notification_log (alert_id);
 */

// ---------------------------------------------------------------------------
// Channel constants
// ---------------------------------------------------------------------------

export const NOTIFICATION_CHANNELS = ["email", "sms"] as const;
export type  NotificationChannel   = typeof NOTIFICATION_CHANNELS[number];

// ---------------------------------------------------------------------------
// Alert category — used for template selection and preference matching
// ---------------------------------------------------------------------------

/**
 * Logical grouping for alert types produced by different services.
 * Used to generate human-readable template text and to allow customers to
 * subscribe to a whole category without listing every specific type.
 */
export type AlertCategory =
  | "environmental"   // temperature_*, humidity_*, pressure_*, co2_*
  | "moisture"        // moisture_*
  | "inventory"       // pile_volume_drop, inventory_*
  | "unknown";

/** Map an alert type string to its category. */
export function classifyAlertType(alertType: string): AlertCategory {
  if (/^(temperature|humidity|pressure|co2)/.test(alertType)) return "environmental";
  if (/^moisture/.test(alertType))                             return "moisture";
  if (/^(pile_volume_drop|inventory)/.test(alertType))         return "inventory";
  return "unknown";
}

// ---------------------------------------------------------------------------
// Notification preference (domain type)
// ---------------------------------------------------------------------------

export interface NotificationPreference {
  id:               string;
  customerId:       string;
  contactName:      string;
  /** Email address, or null if this contact only receives SMS. */
  contactEmail:     string | null;
  /** E.164 phone number, or null if this contact only receives email. */
  contactPhone:     string | null;
  /** Channels to use when severity = "warning".  Empty array = no notification. */
  channelsWarning:  NotificationChannel[];
  /** Channels to use when severity = "critical".  Empty array = no notification. */
  channelsCritical: NotificationChannel[];
  /**
   * Allowlist of alert types.  null means subscribe to all.
   * Individual types (e.g. "temperature_high") or category prefixes
   * (e.g. "temperature_") are both valid.
   */
  alertTypeFilter:  string[] | null;
  /**
   * Allowlist of site UUIDs.  null means subscribe to all sites.
   */
  siteIdFilter:     string[] | null;
  enabled:          boolean;
}

// ---------------------------------------------------------------------------
// Notification request — passed to each INotificationChannel
// ---------------------------------------------------------------------------

export interface NotificationRequest {
  /** Alert ID — used for idempotency key in the notification_log. */
  alertId:     string;
  customerId:  string;
  preferenceId: string;
  contactName: string;
  /** Email address (required for email channel). */
  recipient:   string;
  /** Email subject line.  Ignored by SMS channel. */
  subject:     string;
  /** Plain-text message body. Used by SMS; fallback for email. */
  bodyText:    string;
  /** HTML message body.  Email channel prefers this over bodyText. */
  bodyHtml:    string;
}

// ---------------------------------------------------------------------------
// Notification result
// ---------------------------------------------------------------------------

export type DeliveryStatus = "sent" | "failed" | "skipped";

export interface NotificationResult {
  channel:    NotificationChannel;
  recipient:  string;
  status:     DeliveryStatus;
  /** Provider-assigned message ID (SendGrid message-id, Twilio SID). */
  providerId: string | null;
  /** Error description when status = "failed". */
  error:      string | null;
}

// ---------------------------------------------------------------------------
// Channel interface
// ---------------------------------------------------------------------------

export interface INotificationChannel {
  readonly channel: NotificationChannel;
  /**
   * Deliver one notification.  Never throws — failures are returned as a
   * result with status = "failed" so the router can log and continue.
   */
  send(request: NotificationRequest): Promise<NotificationResult>;
}
