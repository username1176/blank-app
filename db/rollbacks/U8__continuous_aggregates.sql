-- =============================================================================
-- U8: Undo V8 — drop continuous aggregates (daily then hourly)
-- =============================================================================
-- Daily CAs must be dropped before hourly CAs because they depend on them.
-- CASCADE propagates to compression policies attached to each view.

SELECT remove_continuous_aggregate_policy('sensor_daily',   if_exists => TRUE);
SELECT remove_continuous_aggregate_policy('moisture_daily', if_exists => TRUE);
SELECT remove_continuous_aggregate_policy('inventory_daily',if_exists => TRUE);

DROP MATERIALIZED VIEW IF EXISTS sensor_daily    CASCADE;
DROP MATERIALIZED VIEW IF EXISTS moisture_daily  CASCADE;
DROP MATERIALIZED VIEW IF EXISTS inventory_daily CASCADE;

SELECT remove_continuous_aggregate_policy('sensor_hourly',   if_exists => TRUE);
SELECT remove_continuous_aggregate_policy('moisture_hourly', if_exists => TRUE);
SELECT remove_continuous_aggregate_policy('inventory_hourly',if_exists => TRUE);

DROP MATERIALIZED VIEW IF EXISTS sensor_hourly    CASCADE;
DROP MATERIALIZED VIEW IF EXISTS moisture_hourly  CASCADE;
DROP MATERIALIZED VIEW IF EXISTS inventory_hourly CASCADE;
