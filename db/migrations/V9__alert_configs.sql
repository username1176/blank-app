-- =============================================================================
-- V9: Per-customer, per-site alert configuration for inventory drop detection
-- =============================================================================
-- Scope resolution order (most-specific wins):
--   pile-specific  (pile_id IS NOT NULL)
--   site-specific  (pile_id IS NULL, site_id IS NOT NULL)
--   customer-wide  (pile_id IS NULL, site_id IS NULL)
--
-- The UNIQUE constraint on (customer_id, site_id, pile_id, alert_type) enforces
-- at most one config entry per scope level per alert type.

CREATE TABLE alert_configs (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id         UUID        NOT NULL REFERENCES customers(id)  ON DELETE CASCADE,
    site_id             UUID                 REFERENCES sites(id)      ON DELETE CASCADE,
    pile_id             UUID                 REFERENCES piles(id)      ON DELETE CASCADE,
    alert_type          TEXT        NOT NULL DEFAULT 'inventory_drop'
                            CHECK (alert_type IN ('inventory_drop', 'inventory_discrepancy')),
    -- Detection parameters
    drop_threshold_pct  NUMERIC(5, 2) NOT NULL DEFAULT 15.0
                            CHECK (drop_threshold_pct > 0 AND drop_threshold_pct <= 100),
    lookback_minutes    INTEGER     NOT NULL DEFAULT 60
                            CHECK (lookback_minutes > 0),
    cooldown_minutes    INTEGER     NOT NULL DEFAULT 30
                            CHECK (cooldown_minutes > 0),
    severity            TEXT        NOT NULL DEFAULT 'warning'
                            CHECK (severity IN ('info', 'warning', 'critical')),
    enabled             BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- At most one rule per (customer, site, pile, type) scope
    UNIQUE (customer_id, site_id, pile_id, alert_type),
    -- pile_id requires site_id to be set
    CONSTRAINT pile_requires_site CHECK (pile_id IS NULL OR site_id IS NOT NULL)
);

CREATE TRIGGER set_alert_configs_updated_at
    BEFORE UPDATE ON alert_configs
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- ── Indexes ───────────────────────────────────────────────────────────────────

-- Scheduler: fetch all enabled configs (cross-tenant, no GUC set)
CREATE INDEX idx_alert_configs_enabled
    ON alert_configs (alert_type, enabled)
    WHERE enabled = TRUE;

-- API: fetch configs for a specific tenant
CREATE INDEX idx_alert_configs_customer
    ON alert_configs (customer_id, alert_type);

-- Scope resolution: find the tightest match for a pile
CREATE INDEX idx_alert_configs_pile_scope
    ON alert_configs (customer_id, site_id, pile_id, alert_type);
