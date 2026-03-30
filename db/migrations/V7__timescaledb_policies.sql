-- =============================================================================
-- V7: TimescaleDB compression and data-retention policies
-- =============================================================================
-- Compression design
-- ──────────────────
-- compress_segmentby  — high-cardinality tenant/site/pile columns that are
--   repeated across many rows in a chunk. The decompressor can skip entire
--   segments when a query targets a single customer or site, which is the
--   dominant dashboard query shape.
--
-- compress_orderby    — rows are delta-encoded in this order within a segment.
--   time DESC matches the ORDER BY clause in all read queries, maximising
--   delta compression and allowing sorted heap scans on decompressed chunks.
--
-- compress_after      — 7 days: leaves the current week's data uncompressed
--   for fast writes and back-fill inserts from offline edge devices.
--
-- schedule_interval   — compress once per day (overnight) so the compression
--   job does not contend with the peak ingest window.
--
-- Retention
-- ─────────
-- Raw rows are dropped after 2 years. Hourly and daily continuous aggregates
-- (created in V8) have no retention policy and are kept indefinitely.

-- ---------------------------------------------------------------------------
-- inventory_snapshots
-- ---------------------------------------------------------------------------
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

SELECT add_retention_policy(
    'inventory_snapshots',
    drop_after        => INTERVAL '2 years',
    schedule_interval => INTERVAL '1 day'
);

-- ---------------------------------------------------------------------------
-- moisture_readings
-- ---------------------------------------------------------------------------
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

SELECT add_retention_policy(
    'moisture_readings',
    drop_after        => INTERVAL '2 years',
    schedule_interval => INTERVAL '1 day'
);

-- ---------------------------------------------------------------------------
-- sensor_readings
-- ---------------------------------------------------------------------------
-- sensor_id is added to compress_segmentby because a site may have dozens of
-- sensors. Segmenting by sensor_id keeps decompressed segment sizes small and
-- allows per-sensor queries to decompress only the relevant segment.
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

SELECT add_retention_policy(
    'sensor_readings',
    drop_after        => INTERVAL '2 years',
    schedule_interval => INTERVAL '1 day'
);
