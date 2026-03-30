/**
 * SMS notification channel backed by Twilio.
 *
 * Each call to send() creates one Twilio message resource.  The returned SID
 * is stored in the notification_log for status tracking and customer support.
 *
 * Phone numbers must be in E.164 format (+15551234567).  The from-number
 * (TWILIO_FROM_NUMBER) must be a Twilio-provisioned number or messaging
 * service SID that supports SMS.
 *
 * Set NOTIFICATIONS_ENABLED=false or omit TWILIO credentials to use the
 * NoopSmsChannel, which logs the suppressed notification instead.
 */

import twilio from "twilio";
import { env } from "../../config/env";
import { logger } from "../../config/logger";
import {
  INotificationChannel,
  NotificationRequest,
  NotificationResult,
} from "../types";

// ---------------------------------------------------------------------------
// Real channel
// ---------------------------------------------------------------------------

export class TwilioSmsChannel implements INotificationChannel {
  readonly channel = "sms" as const;
  private readonly client: ReturnType<typeof twilio>;

  constructor() {
    this.client = twilio(env.TWILIO_ACCOUNT_SID!, env.TWILIO_AUTH_TOKEN!);
  }

  async send(req: NotificationRequest): Promise<NotificationResult> {
    try {
      const message = await this.client.messages.create({
        to:   req.recipient,
        from: env.TWILIO_FROM_NUMBER,
        body: req.bodyText, // SMS channel receives the pre-formatted smsText as bodyText
      });

      logger.debug("SMS sent", {
        alertId:    req.alertId,
        recipient:  req.recipient,
        sid:        message.sid,
        status:     message.status,
      });

      return {
        channel:    "sms",
        recipient:  req.recipient,
        status:     "sent",
        providerId: message.sid,
        error:      null,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("Failed to send SMS", {
        alertId:   req.alertId,
        recipient: req.recipient,
        error:     message,
      });
      return {
        channel:    "sms",
        recipient:  req.recipient,
        status:     "failed",
        providerId: null,
        error:      message,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// No-op channel
// ---------------------------------------------------------------------------

export class NoopSmsChannel implements INotificationChannel {
  readonly channel = "sms" as const;

  async send(req: NotificationRequest): Promise<NotificationResult> {
    logger.info("SMS suppressed (notifications disabled)", {
      alertId:   req.alertId,
      recipient: req.recipient,
    });
    return { channel: "sms", recipient: req.recipient, status: "skipped", providerId: null, error: null };
  }
}
