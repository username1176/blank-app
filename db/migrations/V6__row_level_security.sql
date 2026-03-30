-- =============================================================================
-- V6: Row-level security (tenant isolation)
-- =============================================================================
-- The application role sets the current tenant before every query:
--   SET LOCAL app.current_customer_id = '<uuid>';
-- All RLS policies enforce that only rows belonging to that tenant are visible
-- or modifiable.  The customers table is intentionally excluded — the API
-- gateway resolves customer identity from the JWT before setting the GUC.

ALTER TABLE sites                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE cameras                ENABLE ROW LEVEL SECURITY;
ALTER TABLE piles                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_snapshots    ENABLE ROW LEVEL SECURITY;
ALTER TABLE moisture_readings      ENABLE ROW LEVEL SECURITY;
ALTER TABLE sensor_readings        ENABLE ROW LEVEL SECURITY;
ALTER TABLE alert_logs             ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_preferences ENABLE ROW LEVEL SECURITY;

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

CREATE POLICY tenant_isolation ON notification_preferences
    USING (customer_id = current_setting('app.current_customer_id')::UUID);
