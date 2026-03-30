-- =============================================================================
-- U4: Undo V4 — drop alerting tables
-- =============================================================================
-- notification_preferences has no dependents; alert_logs may be referenced by
-- application-level FKs in future migrations — drop in creation-reverse order.

DROP TABLE IF EXISTS notification_preferences CASCADE;
DROP TABLE IF EXISTS alert_logs               CASCADE;
