-- =============================================================================
-- V1: Extensions and shared utility functions
-- =============================================================================
-- Prerequisites: TimescaleDB and PostGIS must be installed as server extensions
-- before applying this migration (i.e. present in shared_preload_libraries).

CREATE EXTENSION IF NOT EXISTS timescaledb;
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS "pgcrypto";   -- gen_random_uuid()

-- Reusable trigger function: bumps updated_at on every row change.
-- Referenced by BEFORE UPDATE triggers created in V2 and V4.
CREATE OR REPLACE FUNCTION trigger_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
