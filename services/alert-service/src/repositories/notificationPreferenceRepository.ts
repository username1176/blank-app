/**
 * NotificationPreferenceRepository — fetch customer notification preferences.
 *
 * Preferences are loaded once per incoming alert and filtered in-process.
 * A typical customer has O(10) preference rows, so loading all active
 * preferences per customerId is far cheaper than per-alert DB queries with
 * complex array-overlap conditions.
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

  /**
   * Return all enabled preferences for a customer.
   *
   * Called once per alert — results are filtered in-process by alert type and
   * site rather than with SQL array-overlap operators to keep the query simple.
   */
  async findActive(customerId: string): Promise<NotificationPreference[]> {
    const sql = `
      SELECT id, customer_id, contact_name, contact_email, contact_phone,
             channels_warning, channels_critical,
             alert_type_filter, site_id_filter, enabled
        FROM customer_notification_preferences
       WHERE customer_id = $1
         AND enabled     = TRUE
       ORDER BY created_at ASC
    `;

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL app.current_customer_id = $1", [customerId]);
      const result = await client.query<PreferenceRow>(sql, [customerId]);
      await client.query("COMMIT");
      return result.rows.map(toPreference);
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw mapDbError(err);
    } finally {
      client.release();
    }
  }
}
