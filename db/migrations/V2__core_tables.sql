-- =============================================================================
-- V2: Core reference tables
-- customers → sites → cameras → piles
-- =============================================================================

-- ---------------------------------------------------------------------------
-- customers  (one row per tenant)
-- ---------------------------------------------------------------------------
CREATE TABLE customers (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    name                TEXT        NOT NULL,
    email               TEXT        NOT NULL UNIQUE,
    subscription_tier   TEXT        NOT NULL DEFAULT 'standard'
                            CHECK (subscription_tier IN ('standard', 'professional', 'enterprise')),
    is_active           BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER set_customers_updated_at
    BEFORE UPDATE ON customers
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- ---------------------------------------------------------------------------
-- sites  (warehouse / facility locations per customer)
-- ---------------------------------------------------------------------------
CREATE TABLE sites (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id         UUID        NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    name                TEXT        NOT NULL,
    address             TEXT,
    coordinates         GEOMETRY(POINT, 4326),   -- WGS-84 GPS centroid
    timezone            TEXT        NOT NULL DEFAULT 'UTC',
    is_active           BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (customer_id, name)
);

CREATE TRIGGER set_sites_updated_at
    BEFORE UPDATE ON sites
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- ---------------------------------------------------------------------------
-- cameras  (thermal + RGB edge devices at each site)
-- ---------------------------------------------------------------------------
CREATE TABLE cameras (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id         UUID        NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    site_id             UUID        NOT NULL REFERENCES sites(id)     ON DELETE CASCADE,
    name                TEXT        NOT NULL,
    camera_type         TEXT        NOT NULL
                            CHECK (camera_type IN ('thermal', 'rgb', 'combined')),
    rtsp_url            TEXT,
    position            GEOMETRY(POINT, 4326),
    mounting_height_m   NUMERIC(6, 2),
    fov_degrees         NUMERIC(5, 2),
    is_active           BOOLEAN     NOT NULL DEFAULT TRUE,
    last_seen_at        TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (customer_id, site_id, name)
);

CREATE TRIGGER set_cameras_updated_at
    BEFORE UPDATE ON cameras
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- ---------------------------------------------------------------------------
-- piles  (individual bulk-material storage piles)
-- ---------------------------------------------------------------------------
CREATE TABLE piles (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id         UUID        NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    site_id             UUID        NOT NULL REFERENCES sites(id)     ON DELETE CASCADE,
    name                TEXT        NOT NULL,
    material_type       TEXT        NOT NULL,
    footprint           GEOMETRY(POLYGON, 4326),
    max_capacity_tonnes NUMERIC(12, 2),
    bulk_density_t_m3   NUMERIC(8, 4),
    is_active           BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (customer_id, site_id, name)
);

CREATE TRIGGER set_piles_updated_at
    BEFORE UPDATE ON piles
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
