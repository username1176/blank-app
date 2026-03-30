-- =============================================================================
-- Warehouse Materials Intelligence Platform
-- TimescaleDB Schema — Multi-Tenant Bulk Materials Monitoring
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Extensions
-- ---------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS timescaledb;
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS "pgcrypto";  -- gen_random_uuid()

-- ---------------------------------------------------------------------------
-- Utility: auto-update updated_at on every row change
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trigger_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- =============================================================================
-- CORE / REFERENCE TABLES
-- =============================================================================

-- ---------------------------------------------------------------------------
-- customers  (one row per tenant)
-- ---------------------------------------------------------------------------
CREATE TABLE customers (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    name                TEXT        NOT NULL,
    email               TEXT        NOT NULL UNIQUE,
    subscription_tier   TEXT        NOT NULL DEFAULT 'standard'
                            CHECK (subscription_tier IN ('standard', 'professional', 'enterprise')),
    is_active           BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER set_customers_updated_at
    BEFORE UPDATE ON customers
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- ---------------------------------------------------------------------------
-- sites  (warehouse / facility locations per customer)
-- ---------------------------------------------------------------------------
CREATE TABLE sites (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id         UUID        NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    name                TEXT        NOT NULL,
    address             TEXT,
    coordinates         GEOMETRY(POINT, 4326),   -- WGS-84 GPS centroid
    timezone            TEXT        NOT NULL DEFAULT 'UTC',
    is_active           BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (customer_id, name)
);

CREATE TRIGGER set_sites_updated_at
    BEFORE UPDATE ON sites
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- ---------------------------------------------------------------------------
-- cameras  (thermal + RGB edge devices at each site)
-- ---------------------------------------------------------------------------
CREATE TABLE cameras (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id         UUID        NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    site_id             UUID        NOT NULL REFERENCES sites(id)     ON DELETE CASCADE,
    name                TEXT        NOT NULL,
    camera_type         TEXT        NOT NULL
                            CHECK (camera_type IN ('thermal', 'rgb', 'combined')),
    rtsp_url            TEXT,                       -- streaming endpoint
    position            GEOMETRY(POINT, 4326),      -- physical install location
    mounting_height_m   NUMERIC(6, 2),
    fov_degrees         NUMERIC(5, 2),              -- horizontal field-of-view
    is_active           BOOLEAN     NOT NULL DEFAULT TRUE,
    last_seen_at        TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (customer_id, site_id, name)
);

CREATE TRIGGER set_cameras_updated_at
    BEFORE UPDATE ON cameras
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- ---------------------------------------------------------------------------
-- piles  (individual bulk-material storage piles with 2-D footprint geometry)
-- ---------------------------------------------------------------------------
CREATE TABLE piles (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id         UUID        NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    site_id             UUID        NOT NULL REFERENCES sites(id)     ON DELETE CASCADE,
    name                TEXT        NOT NULL,
    material_type       TEXT        NOT NULL,
        -- e.g. 'aluminum_trihydrate', 'cement', 'fertilizer', 'coal', 'sand'
    footprint           GEOMETRY(POLYGON, 4326),    -- pile boundary on the floor plan
    max_capacity_tonnes NUMERIC(12, 2),
    bulk_density_t_m3   NUMERIC(8, 4),              -- used to convert volume → tonnes
    is_active           BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (customer_id, site_id, name)
);

CREATE TRIGGER set_piles_updated_at
    BEFORE UPDATE ON piles
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- =============================================================================
-- TIME-SERIES TABLES  (converted to TimescaleDB hypertables below)
-- =============================================================================

-- ---------------------------------------------------------------------------
-- inventory_snapshots  (volumetric measurements from camera segmentation)
-- ---------------------------------------------------------------------------
CREATE TABLE inventory_snapshots (
    time                TIMESTAMPTZ NOT NULL,
    customer_id         UUID        NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    site_id             UUID        NOT NULL REFERENCES sites(id)     ON DELETE CASCADE,
    pile_id             UUID        NOT NULL REFERENCES piles(id)     ON DELETE CASCADE,
    camera_id           UUID                 REFERENCES cameras(id)   ON DELETE SET NULL,
    volume_m3           NUMERIC(14, 4) NOT NULL,
    estimated_tonnes    NUMERIC(14, 4),             -- volume_m3 * bulk_density_t_m3
    height_m            NUMERIC(8, 4),              -- peak height of pile
    surface_area_m2     NUMERIC(12, 4),
    confidence_score    NUMERIC(4, 3)
                            CHECK (confidence_score BETWEEN 0 AND 1),
    measurement_source  TEXT        NOT NULL DEFAULT 'camera'
                            CHECK (measurement_source IN ('camera', 'manual', 'edge_sensor')),
    raw_image_path      TEXT,                       -- object-storage URI
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 1-day chunks: edge devices typically push snapshots every 5-15 min
-- → ~100-300 rows/pile/day; 1-day chunks give ~50-150 MB/chunk across a mid-size deployment
-- migrate_data => FALSE is safe at schema-init time (table is empty)
SELECT create_hypertable(
    'inventory_snapshots',
    'time',
    chunk_time_interval => INTERVAL '1 day',
    if_not_exists       => TRUE,
    migrate_data        => FALSE
);

-- ---------------------------------------------------------------------------
-- moisture_readings  (LSTM model predictions from thermal imagery)
-- ---------------------------------------------------------------------------
CREATE TABLE moisture_readings (
    time                TIMESTAMPTZ NOT NULL,
    customer_id         UUID        NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    site_id             UUID        NOT NULL REFERENCES sites(id)     ON DELETE CASCADE,
    pile_id             UUID        NOT NULL REFERENCES piles(id)     ON DELETE CASCADE,
    camera_id           UUID                 REFERENCES cameras(id)   ON DELETE SET NULL,
    moisture_pct        NUMERIC(6, 3)  NOT NULL
                            CHECK (moisture_pct BETWEEN 0 AND 100),
    confidence_score    NUMERIC(4, 3)
                            CHECK (confidence_score BETWEEN 0 AND 1),
    zone_classification TEXT        NOT NULL
                            CHECK (zone_classification IN ('dry', 'normal', 'wet')),
    model_version       TEXT,                       -- tracks which LSTM was used
    thermal_image_path  TEXT,
    ambient_temp_c      NUMERIC(6, 2),              -- snapshot of env conditions
    ambient_humidity_pct NUMERIC(6, 3),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 1-day chunks: LSTM inference runs in-step with inventory captures
SELECT create_hypertable(
    'moisture_readings',
    'time',
    chunk_time_interval => INTERVAL '1 day',
    if_not_exists       => TRUE,
    migrate_data        => FALSE
);

-- ---------------------------------------------------------------------------
-- sensor_readings  (temperature / humidity / auxiliary env sensors)
-- ---------------------------------------------------------------------------
CREATE TABLE sensor_readings (
    time                TIMESTAMPTZ NOT NULL,
    customer_id         UUID        NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    site_id             UUID        NOT NULL REFERENCES sites(id)     ON DELETE CASCADE,
    sensor_id           TEXT        NOT NULL,       -- device identifier
    sensor_type         TEXT        NOT NULL
                            CHECK (sensor_type IN ('temperature', 'humidity', 'combined',
                                                   'pressure', 'co2')),
    -- measured values (nullable: only populate what the sensor reports)
    temperature_c       NUMERIC(7, 3),
    humidity_pct        NUMERIC(6, 3)
                            CHECK (humidity_pct BETWEEN 0 AND 100),
    pressure_hpa        NUMERIC(8, 2),
    co2_ppm             NUMERIC(8, 2),
    -- device health
    battery_pct         NUMERIC(5, 2)
                            CHECK (battery_pct BETWEEN 0 AND 100),
    signal_strength_dbm NUMERIC(6, 2),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 12-hour chunks: sensors can report every 30 s – 5 min; at 120 s cadence
-- a site with 50 sensors generates ~72 k rows/day — 12-hour chunks keep
-- individual chunks at a manageable size and bound open-chunk write amplification
SELECT create_hypertable(
    'sensor_readings',
    'time',
    chunk_time_interval => INTERVAL '12 hours',
    if_not_exists       => TRUE,
    migrate_data        => FALSE
);

-- =============================================================================
-- ALERTING
-- =============================================================================

-- ---------------------------------------------------------------------------
-- alert_logs  (materialised record of every alert event)
-- ---------------------------------------------------------------------------
CREATE TABLE alert_logs (
    id                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id             UUID        NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    site_id                 UUID                 REFERENCES sites(id)     ON DELETE SET NULL,
    pile_id                 UUID                 REFERENCES piles(id)     ON DELETE SET NULL,
    alert_type              TEXT        NOT NULL
                                CHECK (alert_type IN (
                                    'inventory_drop', 'inventory_discrepancy',
                                    'moisture_high', 'moisture_low',
                                    'temperature_anomaly', 'humidity_anomaly',
                                    'camera_offline', 'sensor_offline'
                                )),
    severity                TEXT        NOT NULL DEFAULT 'warning'
                                CHECK (severity IN ('info', 'warning', 'critical')),
    message                 TEXT        NOT NULL,
    details                 JSONB,                  -- arbitrary structured payload
    -- acknowledgement
    acknowledged            BOOLEAN     NOT NULL DEFAULT FALSE,
    acknowledged_by         TEXT,                   -- user email or ID
    acknowledged_at         TIMESTAMPTZ,
    -- delivery tracking
    notification_sent       BOOLEAN     NOT NULL DEFAULT FALSE,
    notification_channels   TEXT[],                 -- e.g. ARRAY['email','sms']
    notification_sent_at    TIMESTAMPTZ,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER set_alert_logs_updated_at
    BEFORE UPDATE ON alert_logs
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- ---------------------------------------------------------------------------
-- notification_preferences  (per-customer alert delivery settings)
-- ---------------------------------------------------------------------------
CREATE TABLE notification_preferences (
    id                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id             UUID        NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    alert_type              TEXT        NOT NULL
                                CHECK (alert_type IN (
                                    'inventory_drop', 'inventory_discrepancy',
                                    'moisture_high', 'moisture_low',
                                    'temperature_anomaly', 'humidity_anomaly',
                                    'camera_offline', 'sensor_offline',
                                    'all'
                                )),
    severity_threshold      TEXT        NOT NULL DEFAULT 'warning'
                                CHECK (severity_threshold IN ('info', 'warning', 'critical')),
    email_enabled           BOOLEAN     NOT NULL DEFAULT TRUE,
    sms_enabled             BOOLEAN     NOT NULL DEFAULT FALSE,
    email_addresses         TEXT[]      NOT NULL DEFAULT '{}',
    phone_numbers           TEXT[]      NOT NULL DEFAULT '{}',
    quiet_hours_start       TIME,                       -- local time, e.g. 22:00
    quiet_hours_end         TIME,                       -- local time, e.g. 07:00
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (customer_id, alert_type)
);

CREATE TRIGGER set_notification_prefs_updated_at
    BEFORE UPDATE ON notification_preferences
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- =============================================================================
-- INDEXES
-- =============================================================================

-- customers
CREATE INDEX idx_customers_email       ON customers (email);

-- sites
CREATE INDEX idx_sites_customer        ON sites (customer_id);
CREATE INDEX idx_sites_coordinates     ON sites USING GIST (coordinates);

-- cameras
CREATE INDEX idx_cameras_customer      ON cameras (customer_id);
CREATE INDEX idx_cameras_site          ON cameras (site_id);
CREATE INDEX idx_cameras_active        ON cameras (site_id) WHERE is_active = TRUE;

-- piles
CREATE INDEX idx_piles_customer        ON piles (customer_id);
CREATE INDEX idx_piles_site            ON piles (site_id);
CREATE INDEX idx_piles_footprint       ON piles USING GIST (footprint);
CREATE INDEX idx_piles_material        ON piles (customer_id, material_type);

-- ---------------------------------------------------------------------------
-- inventory_snapshots
-- Query shapes this index set must serve:
--   A) Dashboard: latest N snapshots for all piles belonging to a tenant
--        WHERE customer_id = $1 ORDER BY time DESC
--   B) Site view: all piles at a given site over a time window
--        WHERE customer_id = $1 AND site_id = $2 AND time BETWEEN $3 AND $4
--   C) Pile drill-down: full history of a single pile
--        WHERE customer_id = $1 AND pile_id = $2 AND time BETWEEN $3 AND $4
--   D) Latest-value per pile (dashboard "current state" card)
--        WHERE pile_id = $1 ORDER BY time DESC LIMIT 1
-- ---------------------------------------------------------------------------

-- (A) tenant-wide range scans
CREATE INDEX idx_inv_snap_customer_time
    ON inventory_snapshots (customer_id, time DESC);

-- (B) site-scoped range scan — primary multi-tenant time-range query
CREATE INDEX idx_inv_snap_customer_site_time
    ON inventory_snapshots (customer_id, site_id, time DESC);

-- (C) pile drill-down — includes frequently-projected columns to allow index-only scans
CREATE INDEX idx_inv_snap_customer_pile_time
    ON inventory_snapshots (customer_id, pile_id, time DESC)
    INCLUDE (volume_m3, estimated_tonnes, height_m, confidence_score);

-- (D) latest-value per pile — fastest path for the "current inventory" widget
CREATE INDEX idx_inv_snap_pile_latest
    ON inventory_snapshots (pile_id, time DESC)
    INCLUDE (volume_m3, estimated_tonnes);

-- ---------------------------------------------------------------------------
-- moisture_readings
-- Query shapes:
--   A) tenant-wide range
--   B) site-scoped range
--   C) pile drill-down with zone filter (e.g. show only 'wet' readings)
--   D) latest moisture per pile
-- ---------------------------------------------------------------------------

CREATE INDEX idx_moist_customer_time
    ON moisture_readings (customer_id, time DESC);

CREATE INDEX idx_moist_customer_site_time
    ON moisture_readings (customer_id, site_id, time DESC);

-- zone_classification first so partial scans (e.g. WHERE zone='wet') stay tight
CREATE INDEX idx_moist_customer_pile_zone_time
    ON moisture_readings (customer_id, pile_id, zone_classification, time DESC)
    INCLUDE (moisture_pct, confidence_score);

CREATE INDEX idx_moist_pile_latest
    ON moisture_readings (pile_id, time DESC)
    INCLUDE (moisture_pct, zone_classification);

-- ---------------------------------------------------------------------------
-- sensor_readings
-- Query shapes:
--   A) tenant-wide range
--   B) site-scoped range — most common: "show all sensors at site X last 24 h"
--   C) single sensor history — anomaly investigation
--   D) type-filtered scan — e.g. "all temperature sensors site X last 1 h"
-- ---------------------------------------------------------------------------

CREATE INDEX idx_sensor_customer_time
    ON sensor_readings (customer_id, time DESC);

CREATE INDEX idx_sensor_customer_site_time
    ON sensor_readings (customer_id, site_id, time DESC);

-- single-sensor history; INCLUDE avoids heap fetch for common projections
CREATE INDEX idx_sensor_customer_sensor_time
    ON sensor_readings (customer_id, sensor_id, time DESC)
    INCLUDE (temperature_c, humidity_pct, pressure_hpa);

-- type-filtered scans at site level (e.g. dashboard shows only humidity sensors)
CREATE INDEX idx_sensor_customer_site_type_time
    ON sensor_readings (customer_id, site_id, sensor_type, time DESC);

-- notification_preferences
CREATE INDEX idx_notif_prefs_customer   ON notification_preferences (customer_id);

-- alert_logs
CREATE INDEX idx_alerts_customer        ON alert_logs (customer_id, created_at DESC);
CREATE INDEX idx_alerts_site            ON alert_logs (site_id,     created_at DESC);
CREATE INDEX idx_alerts_unacked         ON alert_logs (customer_id, severity)
                                            WHERE acknowledged = FALSE;
CREATE INDEX idx_alerts_type            ON alert_logs (customer_id, alert_type, created_at DESC);

-- =============================================================================
-- ROW-LEVEL SECURITY  (tenant isolation)
-- =============================================================================
ALTER TABLE customers          ENABLE ROW LEVEL SECURITY;
ALTER TABLE sites               ENABLE ROW LEVEL SECURITY;
ALTER TABLE cameras             ENABLE ROW LEVEL SECURITY;
ALTER TABLE piles               ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE moisture_readings   ENABLE ROW LEVEL SECURITY;
ALTER TABLE sensor_readings     ENABLE ROW LEVEL SECURITY;
ALTER TABLE alert_logs                ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_preferences  ENABLE ROW LEVEL SECURITY;

-- Application role: api_user — set customer_id on the session before any query:
--   SET app.current_customer_id = '<uuid>';

CREATE POLICY tenant_isolation ON sites
    USING (customer_id = current_setting('app.current_customer_id')::UUID);

CREATE POLICY tenant_isolation ON cameras
    USING (customer_id = current_setting('app.current_customer_id')::UUID);

CREATE POLICY tenant_isolation ON piles
    USING (customer_id = current_setting('app.current_customer_id')::UUID);

CREATE POLICY tenant_isolation ON inventory_snapshots
    USING (customer_id = current_setting('app.current_customer_id')::UUID);

CREATE POLICY tenant_isolation ON moisture_readings
    USING (customer_id = current_setting('app.current_customer_id')::UUID);

CREATE POLICY tenant_isolation ON sensor_readings
    USING (customer_id = current_setting('app.current_customer_id')::UUID);

CREATE POLICY tenant_isolation ON alert_logs
    USING (customer_id = current_setting('app.current_customer_id')::UUID);

CREATE POLICY tenant_isolation ON notification_preferences
    USING (customer_id = current_setting('app.current_customer_id')::UUID);

-- =============================================================================
-- TIMESCALEDB: COMPRESSION & RETENTION POLICIES
-- =============================================================================
-- Compression design notes
-- ─────────────────────────
-- compress_segmentby: columns whose values are repeated across many rows in a
--   chunk — TimescaleDB stores one dictionary entry per distinct value and
--   avoids storing it in every row.  Including site_id lets the decompressor
--   skip whole segments when a query targets a single site, which is the
--   dominant dashboard query shape.
--
-- compress_orderby: within each segment, rows are delta-encoded in this order.
--   time DESC matches the ORDER BY in all read queries, maximising delta
--   compression and allowing sorted heap scans on decompressed chunks.
--
-- schedule_interval: run the compression job once per day so that overnight
--   batches of cold data are compressed before the next business day query
--   load.  The compress_after window (7 days) guarantees no chunk that is
--   still likely to receive back-fills is touched.

-- inventory_snapshots -------------------------------------------------------
ALTER TABLE inventory_snapshots SET (
    timescaledb.compress,
    timescaledb.compress_segmentby = 'customer_id, site_id, pile_id',
    timescaledb.compress_orderby   = 'time DESC'
);
SELECT add_compression_policy(
    'inventory_snapshots',
    compress_after    => INTERVAL '7 days',
    schedule_interval => INTERVAL '1 day'
);

-- moisture_readings ----------------------------------------------------------
ALTER TABLE moisture_readings SET (
    timescaledb.compress,
    timescaledb.compress_segmentby = 'customer_id, site_id, pile_id',
    timescaledb.compress_orderby   = 'time DESC'
);
SELECT add_compression_policy(
    'moisture_readings',
    compress_after    => INTERVAL '7 days',
    schedule_interval => INTERVAL '1 day'
);

-- sensor_readings ------------------------------------------------------------
-- sensor_id is included because a site may have dozens of sensors; segmenting
-- by sensor_id keeps decompressed segment sizes small and lets per-sensor
-- queries decompress only the relevant segment.
ALTER TABLE sensor_readings SET (
    timescaledb.compress,
    timescaledb.compress_segmentby = 'customer_id, site_id, sensor_id',
    timescaledb.compress_orderby   = 'time DESC'
);
SELECT add_compression_policy(
    'sensor_readings',
    compress_after    => INTERVAL '7 days',
    schedule_interval => INTERVAL '1 day'
);

-- Raw data retention ---------------------------------------------------------
-- Raw rows are dropped after 2 years; hourly/daily continuous aggregates are
-- retained indefinitely as they have no retention policy attached.
SELECT add_retention_policy('inventory_snapshots', drop_after => INTERVAL '2 years');
SELECT add_retention_policy('moisture_readings',   drop_after => INTERVAL '2 years');
SELECT add_retention_policy('sensor_readings',     drop_after => INTERVAL '2 years');

-- =============================================================================
-- CONTINUOUS AGGREGATES  (hourly + daily, hierarchical)
-- =============================================================================
-- Hierarchy:  raw hypertable  →  *_hourly  →  *_daily
--
-- Hourly CAs materialise every hour and serve:
--   • Live dashboard time-series charts (last 24 h / 7 d views)
--   • Alerting back-fill checks
--
-- Daily CAs are built from hourly CAs (requires TimescaleDB ≥ 2.9).
-- They serve:
--   • 30 / 90 / 365-day trend charts — avoid scanning millions of raw rows
--   • Reporting exports
--
-- avg-of-averages note: daily AVG is computed from hourly AVGs.  For strict
-- correctness store SUM + COUNT in the hourly view and divide at the daily
-- level; for monitoring dashboards the approximation is acceptable.

-- ---------------------------------------------------------------------------
-- HOURLY AGGREGATES
-- ---------------------------------------------------------------------------

-- inventory_hourly -----------------------------------------------------------
CREATE MATERIALIZED VIEW inventory_hourly
    WITH (timescaledb.continuous, timescaledb.materialized_only = FALSE) AS
SELECT
    time_bucket('1 hour', time)  AS bucket,
    customer_id,
    site_id,
    pile_id,
    AVG(volume_m3)               AS avg_volume_m3,
    MIN(volume_m3)               AS min_volume_m3,
    MAX(volume_m3)               AS max_volume_m3,
    AVG(estimated_tonnes)        AS avg_tonnes,
    MIN(estimated_tonnes)        AS min_tonnes,
    MAX(estimated_tonnes)        AS max_tonnes,
    COUNT(*)                     AS sample_count
FROM inventory_snapshots
GROUP BY bucket, customer_id, site_id, pile_id
WITH NO DATA;

SELECT add_continuous_aggregate_policy('inventory_hourly',
    start_offset      => INTERVAL '3 hours',
    end_offset        => INTERVAL '1 hour',
    schedule_interval => INTERVAL '1 hour');

-- Compress hourly CA chunks older than 7 days
ALTER MATERIALIZED VIEW inventory_hourly SET (timescaledb.compress = TRUE);
SELECT add_compression_policy('inventory_hourly',
    compress_after    => INTERVAL '7 days',
    schedule_interval => INTERVAL '1 day');

-- moisture_hourly ------------------------------------------------------------
CREATE MATERIALIZED VIEW moisture_hourly
    WITH (timescaledb.continuous, timescaledb.materialized_only = FALSE) AS
SELECT
    time_bucket('1 hour', time)  AS bucket,
    customer_id,
    site_id,
    pile_id,
    AVG(moisture_pct)            AS avg_moisture_pct,
    MAX(moisture_pct)            AS max_moisture_pct,
    MIN(moisture_pct)            AS min_moisture_pct,
    AVG(confidence_score)        AS avg_confidence,
    COUNT(*)                     AS sample_count
FROM moisture_readings
GROUP BY bucket, customer_id, site_id, pile_id
WITH NO DATA;

SELECT add_continuous_aggregate_policy('moisture_hourly',
    start_offset      => INTERVAL '3 hours',
    end_offset        => INTERVAL '1 hour',
    schedule_interval => INTERVAL '1 hour');

ALTER MATERIALIZED VIEW moisture_hourly SET (timescaledb.compress = TRUE);
SELECT add_compression_policy('moisture_hourly',
    compress_after    => INTERVAL '7 days',
    schedule_interval => INTERVAL '1 day');

-- sensor_hourly --------------------------------------------------------------
CREATE MATERIALIZED VIEW sensor_hourly
    WITH (timescaledb.continuous, timescaledb.materialized_only = FALSE) AS
SELECT
    time_bucket('1 hour', time)  AS bucket,
    customer_id,
    site_id,
    sensor_id,
    AVG(temperature_c)           AS avg_temp_c,
    MAX(temperature_c)           AS max_temp_c,
    MIN(temperature_c)           AS min_temp_c,
    AVG(humidity_pct)            AS avg_humidity_pct,
    MAX(humidity_pct)            AS max_humidity_pct,
    MIN(humidity_pct)            AS min_humidity_pct,
    COUNT(*)                     AS sample_count
FROM sensor_readings
GROUP BY bucket, customer_id, site_id, sensor_id
WITH NO DATA;

SELECT add_continuous_aggregate_policy('sensor_hourly',
    start_offset      => INTERVAL '3 hours',
    end_offset        => INTERVAL '1 hour',
    schedule_interval => INTERVAL '1 hour');

ALTER MATERIALIZED VIEW sensor_hourly SET (timescaledb.compress = TRUE);
SELECT add_compression_policy('sensor_hourly',
    compress_after    => INTERVAL '7 days',
    schedule_interval => INTERVAL '1 day');

-- ---------------------------------------------------------------------------
-- DAILY AGGREGATES  (hierarchical — built from the hourly CAs above)
-- Requires TimescaleDB ≥ 2.9.  On older versions replace the FROM clause
-- with the raw hypertable and adjust the time_bucket argument accordingly.
-- ---------------------------------------------------------------------------

-- inventory_daily ------------------------------------------------------------
CREATE MATERIALIZED VIEW inventory_daily
    WITH (timescaledb.continuous, timescaledb.materialized_only = FALSE) AS
SELECT
    time_bucket('1 day', bucket) AS bucket,
    customer_id,
    site_id,
    pile_id,
    AVG(avg_volume_m3)           AS avg_volume_m3,
    MIN(min_volume_m3)           AS min_volume_m3,
    MAX(max_volume_m3)           AS max_volume_m3,
    AVG(avg_tonnes)              AS avg_tonnes,
    MIN(min_tonnes)              AS min_tonnes,
    MAX(max_tonnes)              AS max_tonnes,
    SUM(sample_count)            AS sample_count
FROM inventory_hourly
GROUP BY 1, customer_id, site_id, pile_id
WITH NO DATA;

SELECT add_continuous_aggregate_policy('inventory_daily',
    start_offset      => INTERVAL '2 days',
    end_offset        => INTERVAL '1 day',
    schedule_interval => INTERVAL '1 day');

-- moisture_daily -------------------------------------------------------------
CREATE MATERIALIZED VIEW moisture_daily
    WITH (timescaledb.continuous, timescaledb.materialized_only = FALSE) AS
SELECT
    time_bucket('1 day', bucket) AS bucket,
    customer_id,
    site_id,
    pile_id,
    AVG(avg_moisture_pct)        AS avg_moisture_pct,
    MAX(max_moisture_pct)        AS max_moisture_pct,
    MIN(min_moisture_pct)        AS min_moisture_pct,
    AVG(avg_confidence)          AS avg_confidence,
    SUM(sample_count)            AS sample_count
FROM moisture_hourly
GROUP BY 1, customer_id, site_id, pile_id
WITH NO DATA;

SELECT add_continuous_aggregate_policy('moisture_daily',
    start_offset      => INTERVAL '2 days',
    end_offset        => INTERVAL '1 day',
    schedule_interval => INTERVAL '1 day');

-- sensor_daily ---------------------------------------------------------------
CREATE MATERIALIZED VIEW sensor_daily
    WITH (timescaledb.continuous, timescaledb.materialized_only = FALSE) AS
SELECT
    time_bucket('1 day', bucket) AS bucket,
    customer_id,
    site_id,
    sensor_id,
    AVG(avg_temp_c)              AS avg_temp_c,
    MAX(max_temp_c)              AS max_temp_c,
    MIN(min_temp_c)              AS min_temp_c,
    AVG(avg_humidity_pct)        AS avg_humidity_pct,
    MAX(max_humidity_pct)        AS max_humidity_pct,
    MIN(min_humidity_pct)        AS min_humidity_pct,
    SUM(sample_count)            AS sample_count
FROM sensor_hourly
GROUP BY 1, customer_id, site_id, sensor_id
WITH NO DATA;

SELECT add_continuous_aggregate_policy('sensor_daily',
    start_offset      => INTERVAL '2 days',
    end_offset        => INTERVAL '1 day',
    schedule_interval => INTERVAL '1 day');
