-- =============================================================================
-- U7: Undo V7 — remove compression and retention policies
-- =============================================================================

-- sensor_readings
SELECT remove_retention_policy   ('sensor_readings',        if_exists => TRUE);
SELECT remove_compression_policy ('sensor_readings',        if_exists => TRUE);
ALTER  TABLE sensor_readings     SET (timescaledb.compress  = FALSE);

-- moisture_readings
SELECT remove_retention_policy   ('moisture_readings',      if_exists => TRUE);
SELECT remove_compression_policy ('moisture_readings',      if_exists => TRUE);
ALTER  TABLE moisture_readings   SET (timescaledb.compress  = FALSE);

-- inventory_snapshots
SELECT remove_retention_policy   ('inventory_snapshots',    if_exists => TRUE);
SELECT remove_compression_policy ('inventory_snapshots',    if_exists => TRUE);
ALTER  TABLE inventory_snapshots SET (timescaledb.compress  = FALSE);
