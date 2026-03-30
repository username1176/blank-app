-- =============================================================================
-- V5: Indexes
-- =============================================================================
-- Each index block documents the query shapes it serves so the rationale for
-- the column order and INCLUDE list is clear during future maintenance.

-- ---------------------------------------------------------------------------
-- customers / sites / cameras / piles
-- ---------------------------------------------------------------------------
CREATE INDEX idx_customers_email       ON customers (email);

CREATE INDEX idx_sites_customer        ON sites (customer_id);
CREATE INDEX idx_sites_coordinates     ON sites USING GIST (coordinates);

CREATE INDEX idx_cameras_customer      ON cameras (customer_id);
CREATE INDEX idx_cameras_site          ON cameras (site_id);
CREATE INDEX idx_cameras_active        ON cameras (site_id) WHERE is_active = TRUE;

CREATE INDEX idx_piles_customer        ON piles (customer_id);
CREATE INDEX idx_piles_site            ON piles (site_id);
CREATE INDEX idx_piles_footprint       ON piles USING GIST (footprint);
CREATE INDEX idx_piles_material        ON piles (customer_id, material_type);

-- ---------------------------------------------------------------------------
-- inventory_snapshots
-- Query shapes:
--   A) Tenant-wide range scan   WHERE customer_id = $1 ORDER BY time DESC
--   B) Site-scoped range scan   WHERE customer_id = $1 AND site_id = $2
--                                 AND time BETWEEN $3 AND $4
--   C) Pile drill-down          WHERE customer_id = $1 AND pile_id = $2
--                                 AND time BETWEEN $3 AND $4
--   D) Latest value per pile    WHERE pile_id = $1 ORDER BY time DESC LIMIT 1
-- ---------------------------------------------------------------------------
CREATE INDEX idx_inv_snap_customer_time
    ON inventory_snapshots (customer_id, time DESC);

CREATE INDEX idx_inv_snap_customer_site_time
    ON inventory_snapshots (customer_id, site_id, time DESC);

-- INCLUDE avoids a heap fetch for the most-projected columns (index-only scan)
CREATE INDEX idx_inv_snap_customer_pile_time
    ON inventory_snapshots (customer_id, pile_id, time DESC)
    INCLUDE (volume_m3, estimated_tonnes, height_m, confidence_score);

CREATE INDEX idx_inv_snap_pile_latest
    ON inventory_snapshots (pile_id, time DESC)
    INCLUDE (volume_m3, estimated_tonnes);

-- ---------------------------------------------------------------------------
-- moisture_readings
-- Query shapes:
--   A) Tenant-wide range
--   B) Site-scoped range
--   C) Pile drill-down with optional zone filter (WHERE zone_classification = 'wet')
--   D) Latest moisture per pile
-- ---------------------------------------------------------------------------
CREATE INDEX idx_moist_customer_time
    ON moisture_readings (customer_id, time DESC);

CREATE INDEX idx_moist_customer_site_time
    ON moisture_readings (customer_id, site_id, time DESC);

-- zone_classification leads so partial zone scans stay tight
CREATE INDEX idx_moist_customer_pile_zone_time
    ON moisture_readings (customer_id, pile_id, zone_classification, time DESC)
    INCLUDE (moisture_pct, confidence_score);

CREATE INDEX idx_moist_pile_latest
    ON moisture_readings (pile_id, time DESC)
    INCLUDE (moisture_pct, zone_classification);

-- ---------------------------------------------------------------------------
-- sensor_readings
-- Query shapes:
--   A) Tenant-wide range
--   B) Site-scoped range (most common: "all sensors at site X, last 24 h")
--   C) Single sensor history (anomaly investigation)
--   D) Type-filtered scan  (e.g. "all temperature sensors at site X, last 1 h")
-- ---------------------------------------------------------------------------
CREATE INDEX idx_sensor_customer_time
    ON sensor_readings (customer_id, time DESC);

CREATE INDEX idx_sensor_customer_site_time
    ON sensor_readings (customer_id, site_id, time DESC);

CREATE INDEX idx_sensor_customer_sensor_time
    ON sensor_readings (customer_id, sensor_id, time DESC)
    INCLUDE (temperature_c, humidity_pct, pressure_hpa);

CREATE INDEX idx_sensor_customer_site_type_time
    ON sensor_readings (customer_id, site_id, sensor_type, time DESC);

-- ---------------------------------------------------------------------------
-- alert_logs / notification_preferences
-- ---------------------------------------------------------------------------
CREATE INDEX idx_alerts_customer   ON alert_logs (customer_id, created_at DESC);
CREATE INDEX idx_alerts_site       ON alert_logs (site_id,     created_at DESC);
CREATE INDEX idx_alerts_unacked    ON alert_logs (customer_id, severity)
                                       WHERE acknowledged = FALSE;
CREATE INDEX idx_alerts_type       ON alert_logs (customer_id, alert_type, created_at DESC);

CREATE INDEX idx_notif_prefs_customer ON notification_preferences (customer_id);
