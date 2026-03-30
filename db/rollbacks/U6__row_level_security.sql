-- =============================================================================
-- U6: Undo V6 — remove RLS policies and disable row-level security
-- =============================================================================

DROP POLICY IF EXISTS tenant_isolation ON notification_preferences;
DROP POLICY IF EXISTS tenant_isolation ON alert_logs;
DROP POLICY IF EXISTS tenant_isolation ON sensor_readings;
DROP POLICY IF EXISTS tenant_isolation ON moisture_readings;
DROP POLICY IF EXISTS tenant_isolation ON inventory_snapshots;
DROP POLICY IF EXISTS tenant_isolation ON piles;
DROP POLICY IF EXISTS tenant_isolation ON cameras;
DROP POLICY IF EXISTS tenant_isolation ON sites;

ALTER TABLE notification_preferences DISABLE ROW LEVEL SECURITY;
ALTER TABLE alert_logs               DISABLE ROW LEVEL SECURITY;
ALTER TABLE sensor_readings          DISABLE ROW LEVEL SECURITY;
ALTER TABLE moisture_readings        DISABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_snapshots      DISABLE ROW LEVEL SECURITY;
ALTER TABLE piles                    DISABLE ROW LEVEL SECURITY;
ALTER TABLE cameras                  DISABLE ROW LEVEL SECURITY;
ALTER TABLE sites                    DISABLE ROW LEVEL SECURITY;
