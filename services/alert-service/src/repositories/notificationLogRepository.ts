/**
 * NotificationLogRepository — record the outcome of every delivery attempt.
 *
 * Each row captures one channel × preference delivery attempt for one alert.
 * The UNIQUE constraint on (alert_id, preference_id, channel) ensures that
 * Kafka at-least-once redelivery cannot produce duplicate notifications:
 * the second insert is silently skipped (ON CONFLICT DO NOTHING) and the
 * existing "sent" or "failed" row is preserved.
 *
 * Writes are non-transactional (no tenant GUC needed) because notification_log
 * is an append-only audit trail that does not need RLS — the data is written
 * by the service itself, not by user-supplied code.
 */

import { Pool } from "pg";
import { logger } from "../config/logger";
import { mapDbError } from "../db/errors";
import {
  DeliveryStatus,
  NotificationChannel,
} from "../notifications/types";

// ---------------------------------------------------------------------------
// Domain type
// ---------------------------------------------------------------------------

export interface NotificationLogEntry {
  id:           string;
  sentAt:       Date;
  alertId:      string;
  customerId:   string;
  preferenceId: string;
  contactName:  string;
  channel:      NotificationChannel;
  recipient:    string;
  status:       DeliveryStatus;
  providerId:   string | null;
  errorMessage: string | null;
}

// ---------------------------------------------------------------------------
// DB row
// ---------------------------------------------------------------------------

interface LogRow {
  id:            string;
  sent_at:       Date;
  alert_id:      string;
  customer_id:   string;
  preference_id: string;
  contact_name:  string;
  channel:       string;
  recipient:     string;
  status:        string;
  provider_id:   string | null;
  error_message: string | null;
}

// ---------------------------------------------------------------------------
// Insert input
// ---------------------------------------------------------------------------

export interface InsertLogInput {
  alertId:      string;
  customerId:   string;
  preferenceId: string;
  contactName:  string;
  channel:      NotificationChannel;
  recipient:    string;
  status:       DeliveryStatus;
  providerId:   string | null;
  errorMessage: string | null;
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export class NotificationLogRepository {
  constructor(private readonly pool: Pool) {}

  /**
   * Insert one delivery log entry.
   *
   * ON CONFLICT DO NOTHING makes this idempotent: if the notification was
   * already delivered (or attempted) for this (alert, preference, channel)
   * combination, the row is silently preserved and we return false.
   *
   * @returns true when inserted, false when skipped (already exists).
   */
  async insert(input: InsertLogInput): Promise<boolean> {
    const sql = `
      INSERT INTO notification_log (
        alert_id, customer_id, preference_id, contact_name,
        channel, recipient, status, provider_id, error_message
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (alert_id, preference_id, channel) DO NOTHING
    `;

    try {
      const result = await this.pool.query(sql, [
        input.alertId,
        input.customerId,
        input.preferenceId,
        input.contactName,
        input.channel,
        input.recipient,
        input.status,
        input.providerId,
        input.errorMessage,
      ]);
      return (result.rowCount ?? 0) > 0;
    } catch (err) {
      // Log but don't rethrow — a failed audit write must never suppress the
      // original delivery result or cause the router to skip other contacts.
      logger.error("Failed to write notification log entry", {
        alertId:      input.alertId,
        preferenceId: input.preferenceId,
        channel:      input.channel,
        error:        err instanceof Error ? err.message : String(err),
      });
      throw mapDbError(err);
    }
  }

  /**
   * Return recent log entries for a customer — useful for the REST API and
   * support tooling.
   */
  async findByCustomer(
    customerId: string,
    opts: { from?: Date; alertId?: string; limit?: number } = {},
  ): Promise<NotificationLogEntry[]> {
    const from  = opts.from  ?? new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const limit = Math.min(opts.limit ?? 100, 1000);

    const conditions = ["customer_id = $1", "sent_at >= $2"];
    const params: unknown[] = [customerId, from];

    if (opts.alertId !== undefined) {
      params.push(opts.alertId);
      conditions.push(`alert_id = $${params.length}`);
    }

    params.push(limit);

    const sql = `
      SELECT id, sent_at, alert_id, customer_id, preference_id, contact_name,
             channel, recipient, status, provider_id, error_message
        FROM notification_log
       WHERE ${conditions.join("\n         AND ")}
       ORDER BY sent_at DESC
       LIMIT $${params.length}
    `;

    const result = await this.pool.query<LogRow>(sql, params);
    return result.rows.map((row: LogRow) => ({
      id:           row.id,
      sentAt:       row.sent_at,
      alertId:      row.alert_id,
      customerId:   row.customer_id,
      preferenceId: row.preference_id,
      contactName:  row.contact_name,
      channel:      row.channel as NotificationChannel,
      recipient:    row.recipient,
      status:       row.status as DeliveryStatus,
      providerId:   row.provider_id,
      errorMessage: row.error_message,
    }));
  }
}
