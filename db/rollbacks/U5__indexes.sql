-- =============================================================================
-- U5: Undo V5 — drop all application indexes
-- =============================================================================

DROP INDEX IF EXISTS idx_notif_prefs_customer;
DROP INDEX IF EXISTS idx_alerts_type;
DROP INDEX IF EXISTS idx_alerts_unacked;
DROP INDEX IF EXISTS idx_alerts_site;
DROP INDEX IF EXISTS idx_alerts_customer;

DROP INDEX IF EXISTS idx_sensor_customer_site_type_time;
DROP INDEX IF EXISTS idx_sensor_customer_sensor_time;
DROP INDEX IF EXISTS idx_sensor_customer_site_time;
DROP INDEX IF EXISTS idx_sensor_customer_time;

DROP INDEX IF EXISTS idx_moist_pile_latest;
DROP INDEX IF EXISTS idx_moist_customer_pile_zone_time;
DROP INDEX IF EXISTS idx_moist_customer_site_time;
DROP INDEX IF EXISTS idx_moist_customer_time;

DROP INDEX IF EXISTS idx_inv_snap_pile_latest;
DROP INDEX IF EXISTS idx_inv_snap_customer_pile_time;
DROP INDEX IF EXISTS idx_inv_snap_customer_site_time;
DROP INDEX IF EXISTS idx_inv_snap_customer_time;

DROP INDEX IF EXISTS idx_piles_material;
DROP INDEX IF EXISTS idx_piles_footprint;
DROP INDEX IF EXISTS idx_piles_site;
DROP INDEX IF EXISTS idx_piles_customer;

DROP INDEX IF EXISTS idx_cameras_active;
DROP INDEX IF EXISTS idx_cameras_site;
DROP INDEX IF EXISTS idx_cameras_customer;

DROP INDEX IF EXISTS idx_sites_coordinates;
DROP INDEX IF EXISTS idx_sites_customer;

DROP INDEX IF EXISTS idx_customers_email;
