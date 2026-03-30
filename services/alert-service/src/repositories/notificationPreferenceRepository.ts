/**
 * NotificationPreferenceRepository — fetch and manage customer notification
 * preferences (contacts + per-severity channel configuration).
 *
 * Tenant isolation: every query sets the GUC so RLS on
 * customer_notification_preferences sees only the requesting tenant's rows.
 */

import { Pool } from "pg";
import { mapDbError } from "../db/errors";
import {
  NotificationChannel,
  NotificationPreference,
  NOTIFICATION_CHANNELS,
} from "../notifications/types";

// ---------------------------------------------------------------------------
// Upsert input — used by the settings PUT endpoint
// ---------------------------------------------------------------------------

export interface ContactUpsert {
  /** UUID — omit to create a new row; provide to update an existing one. */
  id?:              string;
  contactName:      string;
  contactEmail:     string | null;
  contactPhone:     string | null;
  channelsWarning:  NotificationChannel[];
  channelsCritical: NotificationChannel[];
  alertTypeFilter:  string[] | null;
  siteIdFilter:     string[] | null;
  enabled:          boolean;
}

// ---------------------------------------------------------------------------
// DB row
// ---------------------------------------------------------------------------

interface PreferenceRow {
  id:                string;
  customer_id:       string;
  contact_name:      string;
  contact_email:     string | null;
  contact_phone:     string | null;
  channels_warning:  string[];
  channels_critical: string[];
  alert_type_filter: string[] | null;
  site_id_filter:    string[] | null;
  enabled:           boolean;
}

function toPreference(row: PreferenceRow): NotificationPreference {
  return {
    id:               row.id,
    customerId:       row.customer_id,
    contactName:      row.contact_name,
    contactEmail:     row.contact_email,
    contactPhone:     row.contact_phone,
    channelsWarning:  _filterChannels(row.channels_warning),
    channelsCritical: _filterChannels(row.channels_critical),
    alertTypeFilter:  row.alert_type_filter,
    siteIdFilter:     row.site_id_filter,
    enabled:          row.enabled,
  };
}

/** Sanitise a DB array to only known channel values. */
function _filterChannels(arr: string[]): NotificationChannel[] {
  return arr.filter((c): c is NotificationChannel =>
    (NOTIFICATION_CHANNELS as readonly string[]).includes(c),
  );
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export class NotificationPreferenceRepository {
  constructor(private readonly pool: Pool) {}

  /** Shared SELECT projection. */
  private static readonly COLS = `
    id, customer_id, contact_name, contact_email, contact_phone,
    channels_warning, channels_critical,
    alert_type_filter, site_id_filter, enabled
  `;

  /** Run a SELECT inside a tenant-scoped transaction. */
  private async _query(customerId: string, sql: string, params: unknown[]): Promise<PreferenceRow[]> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL app.current_customer_id = $1", [customerId]);
      const result = await client.query<PreferenceRow>(sql, params);
      await client.query("COMMIT");
      return result.rows;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw mapDbError(err);
    } finally {
      client.release();
    }
  }

  // ── Read — active only (used by the notification router) ──────────────────

  /**
   * Return all enabled preferences for a customer.
   *
   * Called once per alert — results are filtered in-process by alert type and
   * site rather than with SQL array-overlap operators to keep the query simple.
   */
  async findActive(customerId: string): Promise<NotificationPreference[]> {
    const sql = `
      SELECT ${NotificationPreferenceRepository.COLS}
        FROM customer_notification_preferences
       WHERE customer_id = $1
         AND enabled     = TRUE
       ORDER BY created_at ASC
    `;
    const rows = await this._query(customerId, sql, [customerId]);
    return rows.map(toPreference);
  }

  // ── Read — all (used by the settings GET endpoint) ────────────────────────

  /**
   * Return every preference row for a customer (including disabled ones).
   * Used by the settings API so the operator sees the full contact list.
   */
  async findAll(customerId: string): Promise<NotificationPreference[]> {
    const sql = `
      SELECT ${NotificationPreferenceRepository.COLS}
        FROM customer_notification_preferences
       WHERE customer_id = $1
       ORDER BY created_at ASC
    `;
    const rows = await this._query(customerId, sql, [customerId]);
    return rows.map(toPreference);
  }

  // ── Write — replace full contact list ─────────────────────────────────────

  /**
   * Atomically replace all contacts for a customer with the provided list.
   *
   * Strategy:
   *   - Rows whose `id` matches an existing row are updated in-place.
   *   - Rows without an `id` are inserted as new contacts.
   *   - Existing rows NOT referenced by the incoming list are deleted.
   *
   * All changes run inside a single tenant-scoped transaction so a partial
   * failure leaves the table unchanged.
   *
   * @returns The full list of contacts after the operation.
   */
  async replaceAll(
    customerId: string,
    contacts:   ContactUpsert[],
  ): Promise<NotificationPreference[]> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL app.current_customer_id = $1", [customerId]);

      // 1. Collect IDs from the incoming list that already exist in the DB.
      const incomingIds = contacts
        .filter((c) => c.id !== undefined)
        .map((c) => c.id as string);

      // 2. Delete rows that are no longer in the list.
      if (incomingIds.length > 0) {
        await client.query(
          `DELETE FROM customer_notification_preferences
            WHERE customer_id = $1
              AND id != ALL($2::uuid[])`,
          [customerId, incomingIds],
        );
      } else {
        // No rows carry an existing ID → delete everything and start fresh.
        await client.query(
          `DELETE FROM customer_notification_preferences WHERE customer_id = $1`,
          [customerId],
        );
      }

      // 3. Upsert each contact.
      const upsertSql = `
        INSERT INTO customer_notification_preferences (
          id, customer_id, contact_name, contact_email, contact_phone,
          channels_warning, channels_critical,
          alert_type_filter, site_id_filter, enabled, updated_at
        ) VALUES (
          COALESCE($1, gen_random_uuid()), $2, $3, $4, $5,
          $6::text[], $7::text[],
          $8::text[], $9::uuid[],
          $10, NOW()
        )
        ON CONFLICT (id) DO UPDATE SET
          contact_name      = EXCLUDED.contact_name,
          contact_email     = EXCLUDED.contact_email,
          contact_phone     = EXCLUDED.contact_phone,
          channels_warning  = EXCLUDED.channels_warning,
          channels_critical = EXCLUDED.channels_critical,
          alert_type_filter = EXCLUDED.alert_type_filter,
          site_id_filter    = EXCLUDED.site_id_filter,
          enabled           = EXCLUDED.enabled,
          updated_at        = NOW()
        RETURNING ${NotificationPreferenceRepository.COLS}
      `;

      const updated: PreferenceRow[] = [];
      for (const c of contacts) {
        const result = await client.query<PreferenceRow>(upsertSql, [
          c.id       ?? null,
          customerId,
          c.contactName,
          c.contactEmail     ?? null,
          c.contactPhone     ?? null,
          c.channelsWarning,
          c.channelsCritical,
          c.alertTypeFilter  ?? null,
          c.siteIdFilter     ?? null,
          c.enabled,
        ]);
        if (result.rows[0]) updated.push(result.rows[0]);
      }

      await client.query("COMMIT");
      return updated.map(toPreference);
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw mapDbError(err);
    } finally {
      client.release();
    }
  }
}
