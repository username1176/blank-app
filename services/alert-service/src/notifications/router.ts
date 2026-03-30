/**
 * NotificationRouter — routes alert events to the correct customer contacts.
 *
 * Routing algorithm
 * ─────────────────
 * For each incoming alert:
 *
 *   1. Load all enabled preferences for the alert's customerId.
 *
 *   2. For each preference, apply three filters:
 *        a. Alert-type filter  — alertTypeFilter is null (all) OR contains the
 *           alert type OR the alert type starts with any listed prefix.
 *        b. Site filter        — siteIdFilter is null (all) OR the alert's
 *           siteId is in the list.  Alerts with no siteId pass the filter only
 *           if siteIdFilter is null.
 *        c. Severity channels  — select channelsWarning or channelsCritical
 *           based on severity.  Empty array → no delivery for this severity.
 *
 *   3. For each (preference, channel) pair that passes:
 *        a. Resolve the recipient address (contactEmail for email, contactPhone
 *           for SMS).  Skip if the preference has no address for this channel.
 *        b. Check notification_log for an existing row — ON CONFLICT DO NOTHING
 *           in the log insert acts as the idempotency gate.
 *        c. Render the message via templates.formatNotification().
 *        d. Call the channel's send() method.
 *        e. Write the result to notification_log.
 *
 *   4. Log a summary at info level: how many contacts were notified, how many
 *      failed, how many were skipped (already delivered or no address).
 *
 * Error isolation
 * ───────────────
 * Errors in one preference row or one channel must not prevent other contacts
 * from being notified.  All per-contact failures are caught, logged, and
 * recorded in the notification_log.  The caller (Kafka handler) never sees
 * an exception from route().
 */

import { logger } from "../config/logger";
import { NotificationLogRepository } from "../repositories/notificationLogRepository";
import { NotificationPreferenceRepository } from "../repositories/notificationPreferenceRepository";
import { AlertPayload } from "../types/alert";
import { INotificationChannel, NotificationChannel, NotificationPreference } from "./types";
import { formatNotification } from "./templates";

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export class NotificationRouter {
  constructor(
    private readonly preferenceRepo: NotificationPreferenceRepository,
    private readonly logRepo:        NotificationLogRepository,
    private readonly channels:       Map<NotificationChannel, INotificationChannel>,
  ) {}

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Route an alert payload to all matching customer contacts.
   *
   * Never throws — all errors are logged and the Kafka consumer continues
   * processing the next message.
   *
   * @param payload  Validated alert payload from Kafka.
   * @param source   Originating service name (from Kafka header).
   */
  async route(payload: AlertPayload, source: string): Promise<void> {
    try {
      await this._route(payload, source);
    } catch (err) {
      logger.error("NotificationRouter: unexpected error in route()", {
        alertId:    payload.id,
        customerId: payload.customerId,
        error:      err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private async _route(payload: AlertPayload, source: string): Promise<void> {
    // ── 1. Load preferences ───────────────────────────────────────────────────
    let preferences: NotificationPreference[];
    try {
      preferences = await this.preferenceRepo.findActive(payload.customerId);
    } catch (err) {
      logger.error("NotificationRouter: failed to load preferences", {
        alertId:    payload.id,
        customerId: payload.customerId,
        error:      err instanceof Error ? err.message : String(err),
      });
      return;
    }

    if (preferences.length === 0) {
      logger.debug("NotificationRouter: no active preferences for customer", {
        customerId: payload.customerId,
        alertId:    payload.id,
      });
      return;
    }

    // ── 2. Filter + dispatch ──────────────────────────────────────────────────
    const template = formatNotification(payload, source);

    let sent    = 0;
    let failed  = 0;
    let skipped = 0;

    for (const pref of preferences) {
      // 2a. Alert-type filter
      if (!_matchesAlertType(pref.alertTypeFilter, payload.type)) {
        skipped++;
        continue;
      }

      // 2b. Site filter
      if (!_matchesSite(pref.siteIdFilter, payload.siteId)) {
        skipped++;
        continue;
      }

      // 2c. Determine channels for this severity
      const channels = payload.severity === "critical"
        ? pref.channelsCritical
        : pref.channelsWarning;

      if (channels.length === 0) {
        logger.debug("NotificationRouter: no channels configured for severity", {
          preferenceId: pref.id,
          severity:     payload.severity,
        });
        skipped++;
        continue;
      }

      // ── 3. Deliver via each channel ─────────────────────────────────────────
      for (const channelName of channels) {
        const channel = this.channels.get(channelName);
        if (!channel) {
          logger.warn("NotificationRouter: unknown channel", { channelName, preferenceId: pref.id });
          skipped++;
          continue;
        }

        // 3a. Resolve recipient address
        const recipient = _resolveRecipient(pref, channelName);
        if (!recipient) {
          logger.debug("NotificationRouter: no address for channel", {
            preferenceId: pref.id,
            channel:      channelName,
          });
          skipped++;
          continue;
        }

        // 3b–d. Build request, send, record result
        const result = await channel.send({
          alertId:      payload.id,
          customerId:   payload.customerId,
          preferenceId: pref.id,
          contactName:  pref.contactName,
          recipient,
          subject:      template.subject,
          // SMS channel receives smsText as bodyText; email channel gets the full body
          bodyText:     channelName === "sms" ? template.smsText : template.bodyText,
          bodyHtml:     template.bodyHtml,
        });

        // 3e. Log outcome (idempotent — conflict = already delivered)
        try {
          const inserted = await this.logRepo.insert({
            alertId:      payload.id,
            customerId:   payload.customerId,
            preferenceId: pref.id,
            contactName:  pref.contactName,
            channel:      channelName,
            recipient,
            status:       result.status,
            providerId:   result.providerId,
            errorMessage: result.error,
          });

          if (!inserted) {
            // The UNIQUE constraint fired — this alert was already delivered to this contact.
            logger.debug("NotificationRouter: delivery already logged, skipping duplicate", {
              alertId:      payload.id,
              preferenceId: pref.id,
              channel:      channelName,
            });
            skipped++;
            continue;
          }
        } catch {
          // Log write failure is non-fatal — the notification may already be sent.
        }

        if (result.status === "sent")    sent++;
        else if (result.status === "failed") failed++;
        else skipped++;
      }
    }

    logger.info("NotificationRouter: routing complete", {
      alertId:    payload.id,
      alertType:  payload.type,
      severity:   payload.severity,
      customerId: payload.customerId,
      sent,
      failed,
      skipped,
    });
  }
}

// ---------------------------------------------------------------------------
// Filter helpers
// ---------------------------------------------------------------------------

/**
 * Returns true when the alert type matches the preference filter.
 *
 * Matching rules (OR logic across filter entries):
 *   - null filter    → all types match
 *   - exact match    → "temperature_high" matches "temperature_high"
 *   - prefix match   → "temperature_" matches "temperature_high"
 */
function _matchesAlertType(filter: string[] | null, alertType: string): boolean {
  if (filter === null) return true;
  return filter.some(
    (f) => alertType === f || alertType.startsWith(f),
  );
}

/**
 * Returns true when the alert's siteId matches the preference filter.
 *
 *   - null filter         → all sites (and no-site alerts) match
 *   - non-null filter     → exact UUID match required
 *   - alert has no siteId → only passes when filter is null
 */
function _matchesSite(filter: string[] | null, siteId: string | undefined): boolean {
  if (filter === null) return true;
  if (!siteId)         return false;
  return filter.includes(siteId);
}

/**
 * Resolve the delivery address for a channel.
 * Returns null when the preference has no address configured for this channel.
 */
function _resolveRecipient(
  pref:    NotificationPreference,
  channel: NotificationChannel,
): string | null {
  switch (channel) {
    case "email": return pref.contactEmail;
    case "sms":   return pref.contactPhone;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build a NotificationRouter from repos and channel implementations.
 * Called once at startup and shared across all Kafka messages.
 */
export function createNotificationRouter(
  preferenceRepo: NotificationPreferenceRepository,
  logRepo:        NotificationLogRepository,
  emailChannel:   INotificationChannel,
  smsChannel:     INotificationChannel,
): NotificationRouter {
  const channels = new Map<NotificationChannel, INotificationChannel>([
    ["email", emailChannel],
    ["sms",   smsChannel],
  ]);
  return new NotificationRouter(preferenceRepo, logRepo, channels);
}
