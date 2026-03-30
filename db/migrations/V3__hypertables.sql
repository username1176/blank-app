-- =============================================================================
-- V3: Time-series tables converted to TimescaleDB hypertables
-- =============================================================================
-- Chunk interval rationale
-- ────────────────────────
-- inventory_snapshots / moisture_readings: edge devices push every 5–15 min,
--   yielding ~100–300 rows/pile/day. 1-day chunks keep individual chunk sizes
--   in the 50–150 MB range across a mid-size deployment.
--
-- sensor_readings: sensors can report every 30 s – 5 min. At a 2-min cadence a
--   site with 50 sensors produces ~72 k rows/day. 12-hour chunks bound chunk
--   size while limiting the number of open (uncompressed) chunks in flight.

-- ---------------------------------------------------------------------------
-- inventory_snapshots
-- ---------------------------------------------------------------------------
CREATE TABLE inventory_snapshots (
    time                TIMESTAMPTZ   NOT NULL,
    customer_id         UUID          NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    site_id             UUID          NOT NULL REFERENCES sites(id)     ON DELETE CASCADE,
    pile_id             UUID          NOT NULL REFERENCES piles(id)     ON DELETE CASCADE,
    camera_id           UUID                   REFERENCES cameras(id)   ON DELETE SET NULL,
    volume_m3           NUMERIC(14, 4) NOT NULL,
    estimated_tonnes    NUMERIC(14, 4),             -- volume_m3 * bulk_density_t_m3
    height_m            NUMERIC(8, 4),
    surface_area_m2     NUMERIC(12, 4),
    confidence_score    NUMERIC(4, 3)
                            CHECK (confidence_score BETWEEN 0 AND 1),
    measurement_source  TEXT          NOT NULL DEFAULT 'camera'
                            CHECK (measurement_source IN ('camera', 'manual', 'edge_sensor')),
    raw_image_path      TEXT,
    created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

SELECT create_hypertable(
    'inventory_snapshots',
    'time',
    chunk_time_interval => INTERVAL '1 day',
    if_not_exists       => TRUE,
    migrate_data        => FALSE
);

-- ---------------------------------------------------------------------------
-- moisture_readings
-- ---------------------------------------------------------------------------
CREATE TABLE moisture_readings (
    time                TIMESTAMPTZ   NOT NULL,
    customer_id         UUID          NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    site_id             UUID          NOT NULL REFERENCES sites(id)     ON DELETE CASCADE,
    pile_id             UUID          NOT NULL REFERENCES piles(id)     ON DELETE CASCADE,
    camera_id           UUID                   REFERENCES cameras(id)   ON DELETE SET NULL,
    moisture_pct        NUMERIC(6, 3) NOT NULL
                            CHECK (moisture_pct BETWEEN 0 AND 100),
    confidence_score    NUMERIC(4, 3)
                            CHECK (confidence_score BETWEEN 0 AND 1),
    zone_classification TEXT          NOT NULL
                            CHECK (zone_classification IN ('dry', 'normal', 'wet')),
    model_version       TEXT,
    thermal_image_path  TEXT,
    ambient_temp_c      NUMERIC(6, 2),
    ambient_humidity_pct NUMERIC(6, 3),
    created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

SELECT create_hypertable(
    'moisture_readings',
    'time',
    chunk_time_interval => INTERVAL '1 day',
    if_not_exists       => TRUE,
    migrate_data        => FALSE
);

-- ---------------------------------------------------------------------------
-- sensor_readings
-- ---------------------------------------------------------------------------
CREATE TABLE sensor_readings (
    time                TIMESTAMPTZ   NOT NULL,
    customer_id         UUID          NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    site_id             UUID          NOT NULL REFERENCES sites(id)     ON DELETE CASCADE,
    sensor_id           TEXT          NOT NULL,
    sensor_type         TEXT          NOT NULL
                            CHECK (sensor_type IN ('temperature', 'humidity', 'combined',
                                                   'pressure', 'co2')),
    temperature_c       NUMERIC(7, 3),
    humidity_pct        NUMERIC(6, 3)
                            CHECK (humidity_pct BETWEEN 0 AND 100),
    pressure_hpa        NUMERIC(8, 2),
    co2_ppm             NUMERIC(8, 2),
    battery_pct         NUMERIC(5, 2)
                            CHECK (battery_pct BETWEEN 0 AND 100),
    signal_strength_dbm NUMERIC(6, 2),
    created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

SELECT create_hypertable(
    'sensor_readings',
    'time',
    chunk_time_interval => INTERVAL '12 hours',
    if_not_exists       => TRUE,
    migrate_data        => FALSE
);
