/**
 * Email notification channel backed by SendGrid.
 *
 * Each call to send() makes one synchronous API request.  The result captures
 * the provider's message ID (X-Message-Id header) for traceability.
 *
 * Set NOTIFICATIONS_ENABLED=false or omit SENDGRID_API_KEY to use the
 * NoopEmailChannel, which logs the suppressed notification instead.
 */

import sgMail from "@sendgrid/mail";
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

export class SendGridEmailChannel implements INotificationChannel {
  readonly channel = "email" as const;

  constructor() {
    sgMail.setApiKey(env.SENDGRID_API_KEY!);
  }

  async send(req: NotificationRequest): Promise<NotificationResult> {
    try {
      const [response] = await sgMail.send({
        to:      req.recipient,
        from: {
          email: env.SENDGRID_FROM_EMAIL,
          name:  env.SENDGRID_FROM_NAME,
        },
        subject:  req.subject,
        text:     req.bodyText,
        html:     req.bodyHtml,
        // Custom args are stored with the message in the SendGrid dashboard.
        customArgs: {
          alertId:    req.alertId,
          customerId: req.customerId,
        },
      });

      // SendGrid returns the message ID in the X-Message-Id response header.
      const providerId = (
        response.headers?.["x-message-id"] as string | undefined
      ) ?? null;

      logger.debug("Email sent", {
        alertId:      req.alertId,
        recipient:    req.recipient,
        subject:      req.subject,
        providerId,
      });

      return { channel: "email", recipient: req.recipient, status: "sent", providerId, error: null };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("Failed to send email", {
        alertId:   req.alertId,
        recipient: req.recipient,
        error:     message,
      });
      return { channel: "email", recipient: req.recipient, status: "failed", providerId: null, error: message };
    }
  }
}

// ---------------------------------------------------------------------------
// No-op channel
// ---------------------------------------------------------------------------

export class NoopEmailChannel implements INotificationChannel {
  readonly channel = "email" as const;

  async send(req: NotificationRequest): Promise<NotificationResult> {
    logger.info("Email suppressed (notifications disabled)", {
      alertId:   req.alertId,
      recipient: req.recipient,
      subject:   req.subject,
    });
    return { channel: "email", recipient: req.recipient, status: "skipped", providerId: null, error: null };
  }
}
