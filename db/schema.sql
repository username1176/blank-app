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

SELECT create_hypertable('inventory_snapshots', 'time');

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

SELECT create_hypertable('moisture_readings', 'time');

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

SELECT create_hypertable('sensor_readings', 'time');

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

-- inventory_snapshots  (time-series: (customer, pile) × time is the hot path)
CREATE INDEX idx_inv_snap_customer_time ON inventory_snapshots (customer_id, time DESC);
CREATE INDEX idx_inv_snap_pile_time     ON inventory_snapshots (pile_id,     time DESC);
CREATE INDEX idx_inv_snap_site_time     ON inventory_snapshots (site_id,     time DESC);

-- moisture_readings
CREATE INDEX idx_moist_customer_time    ON moisture_readings (customer_id, time DESC);
CREATE INDEX idx_moist_pile_time        ON moisture_readings (pile_id,     time DESC);
CREATE INDEX idx_moist_zone             ON moisture_readings (pile_id, zone_classification, time DESC);

-- sensor_readings
CREATE INDEX idx_sensor_customer_time   ON sensor_readings (customer_id, time DESC);
CREATE INDEX idx_sensor_site_time       ON sensor_readings (site_id,     time DESC);
CREATE INDEX idx_sensor_id_time         ON sensor_readings (sensor_id,   time DESC);

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
ALTER TABLE alert_logs          ENABLE ROW LEVEL SECURITY;

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

-- =============================================================================
-- TIMESCALEDB: COMPRESSION & RETENTION POLICIES
-- =============================================================================

-- Compress chunks older than 7 days (storage efficiency for cold data)
ALTER TABLE inventory_snapshots SET (
    timescaledb.compress,
    timescaledb.compress_segmentby = 'customer_id, pile_id',
    timescaledb.compress_orderby   = 'time DESC'
);
SELECT add_compression_policy('inventory_snapshots', INTERVAL '7 days');

ALTER TABLE moisture_readings SET (
    timescaledb.compress,
    timescaledb.compress_segmentby = 'customer_id, pile_id',
    timescaledb.compress_orderby   = 'time DESC'
);
SELECT add_compression_policy('moisture_readings', INTERVAL '7 days');

ALTER TABLE sensor_readings SET (
    timescaledb.compress,
    timescaledb.compress_segmentby = 'customer_id, sensor_id',
    timescaledb.compress_orderby   = 'time DESC'
);
SELECT add_compression_policy('sensor_readings', INTERVAL '7 days');

-- Drop raw data after 2 years (adjust per retention requirements)
SELECT add_retention_policy('inventory_snapshots', INTERVAL '2 years');
SELECT add_retention_policy('moisture_readings',   INTERVAL '2 years');
SELECT add_retention_policy('sensor_readings',     INTERVAL '2 years');

-- =============================================================================
-- CONTINUOUS AGGREGATES  (pre-rolled hourly & daily summaries)
-- =============================================================================

-- Hourly inventory summary per pile
CREATE MATERIALIZED VIEW inventory_hourly
    WITH (timescaledb.continuous) AS
SELECT
    time_bucket('1 hour', time)  AS bucket,
    customer_id,
    site_id,
    pile_id,
    AVG(volume_m3)               AS avg_volume_m3,
    MIN(volume_m3)               AS min_volume_m3,
    MAX(volume_m3)               AS max_volume_m3,
    AVG(estimated_tonnes)        AS avg_tonnes,
    COUNT(*)                     AS sample_count
FROM inventory_snapshots
GROUP BY bucket, customer_id, site_id, pile_id
WITH NO DATA;

SELECT add_continuous_aggregate_policy('inventory_hourly',
    start_offset => INTERVAL '3 hours',
    end_offset   => INTERVAL '1 hour',
    schedule_interval => INTERVAL '1 hour');

-- Hourly moisture summary per pile
CREATE MATERIALIZED VIEW moisture_hourly
    WITH (timescaledb.continuous) AS
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
    start_offset => INTERVAL '3 hours',
    end_offset   => INTERVAL '1 hour',
    schedule_interval => INTERVAL '1 hour');

-- Hourly sensor summary per site/sensor
CREATE MATERIALIZED VIEW sensor_hourly
    WITH (timescaledb.continuous) AS
SELECT
    time_bucket('1 hour', time)  AS bucket,
    customer_id,
    site_id,
    sensor_id,
    AVG(temperature_c)           AS avg_temp_c,
    MAX(temperature_c)           AS max_temp_c,
    MIN(temperature_c)           AS min_temp_c,
    AVG(humidity_pct)            AS avg_humidity_pct,
    COUNT(*)                     AS sample_count
FROM sensor_readings
GROUP BY bucket, customer_id, site_id, sensor_id
WITH NO DATA;

SELECT add_continuous_aggregate_policy('sensor_hourly',
    start_offset => INTERVAL '3 hours',
    end_offset   => INTERVAL '1 hour',
    schedule_interval => INTERVAL '1 hour');
