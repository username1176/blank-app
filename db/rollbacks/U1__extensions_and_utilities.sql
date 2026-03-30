-- =============================================================================
-- U1: Undo V1 — remove utility function
-- =============================================================================
-- Extensions are intentionally NOT dropped here.  Removing timescaledb or
-- postgis with CASCADE would destroy unrelated objects and is almost never
-- the right action in a rollback.  Deinstall extensions manually only when
-- decommissioning the database entirely.

DROP FUNCTION IF EXISTS trigger_set_updated_at() CASCADE;
