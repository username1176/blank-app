-- =============================================================================
-- U3: Undo V3 — drop hypertables
-- =============================================================================
-- Dropping a hypertable also removes all its chunks, associated compression
-- jobs, and retention jobs created in V7 (if V7 was applied).  Run U7 first
-- if policies need to be removed cleanly before the tables are dropped.

DROP TABLE IF EXISTS sensor_readings        CASCADE;
DROP TABLE IF EXISTS moisture_readings      CASCADE;
DROP TABLE IF EXISTS inventory_snapshots    CASCADE;
