-- =============================================================================
-- V4: Alerting and notification tables
-- =============================================================================

-- ---------------------------------------------------------------------------
-- alert_logs  (materialised record of every alert event)
-- ---------------------------------------------------------------------------
CREATE TABLE alert_logs (
    id                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id             UUID        NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    site_id                 UUID                 REFERENCES sites(id)     ON DELETE SET NULL,
    pile_id                 UUID                 REFERENCES piles(id)     ON DELETE SET NULL,
    alert_type              TEXT        NOT NULL
                                CHECK (alert_type IN (
                                    'inventory_drop', 'inventory_discrepancy',
                                    'moisture_high', 'moisture_low',
                                    'temperature_anomaly', 'humidity_anomaly',
                                    'camera_offline', 'sensor_offline'
                                )),
    severity                TEXT        NOT NULL DEFAULT 'warning'
                                CHECK (severity IN ('info', 'warning', 'critical')),
    message                 TEXT        NOT NULL,
    details                 JSONB,
    acknowledged            BOOLEAN     NOT NULL DEFAULT FALSE,
    acknowledged_by         TEXT,
    acknowledged_at         TIMESTAMPTZ,
    notification_sent       BOOLEAN     NOT NULL DEFAULT FALSE,
    notification_channels   TEXT[],
    notification_sent_at    TIMESTAMPTZ,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER set_alert_logs_updated_at
    BEFORE UPDATE ON alert_logs
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- ---------------------------------------------------------------------------
-- notification_preferences  (per-customer, per-alert-type delivery rules)
-- ---------------------------------------------------------------------------
CREATE TABLE notification_preferences (
    id                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id             UUID        NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    alert_type              TEXT        NOT NULL
                                CHECK (alert_type IN (
                                    'inventory_drop', 'inventory_discrepancy',
                                    'moisture_high', 'moisture_low',
                                    'temperature_anomaly', 'humidity_anomaly',
                                    'camera_offline', 'sensor_offline',
                                    'all'
                                )),
    severity_threshold      TEXT        NOT NULL DEFAULT 'warning'
                                CHECK (severity_threshold IN ('info', 'warning', 'critical')),
    email_enabled           BOOLEAN     NOT NULL DEFAULT TRUE,
    sms_enabled             BOOLEAN     NOT NULL DEFAULT FALSE,
    email_addresses         TEXT[]      NOT NULL DEFAULT '{}',
    phone_numbers           TEXT[]      NOT NULL DEFAULT '{}',
    quiet_hours_start       TIME,
    quiet_hours_end         TIME,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (customer_id, alert_type)
);

CREATE TRIGGER set_notification_prefs_updated_at
    BEFORE UPDATE ON notification_preferences
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
