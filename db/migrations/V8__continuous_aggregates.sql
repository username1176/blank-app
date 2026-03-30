-- =============================================================================
-- V8: Continuous aggregates — hierarchical hourly → daily
-- =============================================================================
-- Requires TimescaleDB ≥ 2.9 for hierarchical continuous aggregates
-- (daily CA built from hourly CA rather than raw hypertable).
--
-- Hourly CAs materialise every hour and serve:
--   • Live dashboard time-series charts (last 24 h / 7 d views)
--   • Alerting back-fill checks
--
-- Daily CAs serve:
--   • 30 / 90 / 365-day trend charts (avoids scanning millions of raw rows)
--   • Reporting exports
--
-- avg-of-averages note: daily AVG is computed from hourly AVGs. For strict
-- statistical correctness, store SUM + COUNT in the hourly view and divide
-- at the daily level; for monitoring dashboards this approximation is fine.
--
-- Policy offsets
--   start_offset: how far back to (re)materialise on each run — covers
--     late-arriving data from offline edge devices.
--   end_offset:   leave the most-recent interval unmaterialised so in-flight
--     writes are not partially captured.

-- =============================================================================
-- HOURLY AGGREGATES
-- =============================================================================

-- ---------------------------------------------------------------------------
-- inventory_hourly
-- ---------------------------------------------------------------------------
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

ALTER MATERIALIZED VIEW inventory_hourly SET (timescaledb.compress = TRUE);
SELECT add_compression_policy('inventory_hourly',
    compress_after    => INTERVAL '7 days',
    schedule_interval => INTERVAL '1 day');

-- ---------------------------------------------------------------------------
-- moisture_hourly
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- sensor_hourly
-- ---------------------------------------------------------------------------
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

-- =============================================================================
-- DAILY AGGREGATES  (hierarchical — built from hourly CAs)
-- =============================================================================

-- ---------------------------------------------------------------------------
-- inventory_daily
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- moisture_daily
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- sensor_daily
-- ---------------------------------------------------------------------------
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
