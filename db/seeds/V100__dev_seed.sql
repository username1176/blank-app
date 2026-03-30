-- =============================================================================
-- V100: Development seed data
-- =============================================================================
-- Applies AFTER all schema migrations (V1–V8).
-- Uses fixed UUIDs so the seed is idempotent and test fixtures can reference
-- stable IDs without querying the database first.
--
-- To apply:  make seed   (see Makefile)
-- To wipe:   make db-reset  (drops and recreates the database, then re-migrates)
--
-- Customers  ─  2
-- Sites      ─  5  (2 for Acme, 3 for BlueRidge)
-- Piles      ─  8  (3 + 2 + 2 + 1 + ... see below)
-- Cameras    ─  7  (thermal + RGB pairs at main sites, thermal-only elsewhere)
-- Sensors    ─  6  (combined temp/humidity at each site)
-- Notification preferences  ─  2 catch-all rows (one per customer)
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Customers
-- ---------------------------------------------------------------------------
INSERT INTO customers (id, name, email, subscription_tier, is_active)
VALUES
    (
        '11111111-1111-1111-1111-111111111001',
        'Acme Minerals',
        'ops@acme-minerals.example.com',
        'enterprise',
        TRUE
    ),
    (
        '11111111-1111-1111-1111-111111111002',
        'BlueRidge Cement',
        'ops@blueridge-cement.example.com',
        'professional',
        TRUE
    )
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Sites
-- ---------------------------------------------------------------------------
INSERT INTO sites (id, customer_id, name, address, coordinates, timezone, is_active)
VALUES
    -- Acme Minerals — Warehouse A (Birmingham, AL)
    (
        '22222222-2222-2222-2222-222222222001',
        '11111111-1111-1111-1111-111111111001',
        'Warehouse A',
        '1400 Industrial Blvd, Birmingham, AL 35203',
        ST_SetSRID(ST_MakePoint(-86.8025, 33.5186), 4326),
        'America/Chicago',
        TRUE
    ),
    -- Acme Minerals — Warehouse B (Atlanta, GA)
    (
        '22222222-2222-2222-2222-222222222002',
        '11111111-1111-1111-1111-111111111001',
        'Warehouse B',
        '800 Logistics Pkwy, Atlanta, GA 30336',
        ST_SetSRID(ST_MakePoint(-84.4539, 33.6407), 4326),
        'America/New_York',
        TRUE
    ),
    -- BlueRidge Cement — Main Plant (Charlotte, NC)
    (
        '22222222-2222-2222-2222-222222222003',
        '11111111-1111-1111-1111-111111111002',
        'Main Plant',
        '3200 Cement Works Rd, Charlotte, NC 28273',
        ST_SetSRID(ST_MakePoint(-80.9001, 35.1495), 4326),
        'America/New_York',
        TRUE
    ),
    -- BlueRidge Cement — Storage Lot (Charlotte, NC)
    (
        '22222222-2222-2222-2222-222222222004',
        '11111111-1111-1111-1111-111111111002',
        'Storage Lot',
        '3250 Cement Works Rd, Charlotte, NC 28273',
        ST_SetSRID(ST_MakePoint(-80.8990, 35.1488), 4326),
        'America/New_York',
        TRUE
    ),
    -- BlueRidge Cement — East Depot (Raleigh, NC)
    (
        '22222222-2222-2222-2222-222222222005',
        '11111111-1111-1111-1111-111111111002',
        'East Depot',
        '900 Depot Dr, Raleigh, NC 27603',
        ST_SetSRID(ST_MakePoint(-78.6382, 35.7796), 4326),
        'America/New_York',
        TRUE
    )
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Cameras
-- ---------------------------------------------------------------------------
INSERT INTO cameras (id, customer_id, site_id, name, camera_type,
                     rtsp_url, mounting_height_m, fov_degrees, is_active)
VALUES
    -- Warehouse A: thermal + RGB pair
    (
        '33333333-3333-3333-3333-333333333001',
        '11111111-1111-1111-1111-111111111001',
        '22222222-2222-2222-2222-222222222001',
        'CAM-A-THERMAL-01', 'thermal',
        'rtsp://10.10.1.11:554/stream', 8.0, 90.0, TRUE
    ),
    (
        '33333333-3333-3333-3333-333333333002',
        '11111111-1111-1111-1111-111111111001',
        '22222222-2222-2222-2222-222222222001',
        'CAM-A-RGB-01', 'rgb',
        'rtsp://10.10.1.12:554/stream', 8.0, 90.0, TRUE
    ),
    -- Warehouse B: thermal only
    (
        '33333333-3333-3333-3333-333333333003',
        '11111111-1111-1111-1111-111111111001',
        '22222222-2222-2222-2222-222222222002',
        'CAM-B-THERMAL-01', 'thermal',
        'rtsp://10.10.2.11:554/stream', 7.5, 85.0, TRUE
    ),
    -- Main Plant: thermal + RGB pair
    (
        '33333333-3333-3333-3333-333333333004',
        '11111111-1111-1111-1111-111111111002',
        '22222222-2222-2222-2222-222222222003',
        'CAM-MP-THERMAL-01', 'thermal',
        'rtsp://10.20.1.11:554/stream', 10.0, 95.0, TRUE
    ),
    (
        '33333333-3333-3333-3333-333333333005',
        '11111111-1111-1111-1111-111111111002',
        '22222222-2222-2222-2222-222222222003',
        'CAM-MP-RGB-01', 'rgb',
        'rtsp://10.20.1.12:554/stream', 10.0, 95.0, TRUE
    ),
    -- Storage Lot: thermal only
    (
        '33333333-3333-3333-3333-333333333006',
        '11111111-1111-1111-1111-111111111002',
        '22222222-2222-2222-2222-222222222004',
        'CAM-SL-THERMAL-01', 'thermal',
        'rtsp://10.20.2.11:554/stream', 6.0, 80.0, TRUE
    ),
    -- East Depot: thermal only
    (
        '33333333-3333-3333-3333-333333333007',
        '11111111-1111-1111-1111-111111111002',
        '22222222-2222-2222-2222-222222222005',
        'CAM-ED-THERMAL-01', 'thermal',
        'rtsp://10.20.3.11:554/stream', 6.0, 80.0, TRUE
    )
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Piles
-- ---------------------------------------------------------------------------
INSERT INTO piles (id, customer_id, site_id, name, material_type,
                   max_capacity_tonnes, bulk_density_t_m3, is_active)
VALUES
    -- Warehouse A — 3 piles
    (
        '44444444-4444-4444-4444-444444444001',
        '11111111-1111-1111-1111-111111111001',
        '22222222-2222-2222-2222-222222222001',
        'Pile-A1', 'aluminum_trihydrate', 8000.00, 2.42, TRUE
    ),
    (
        '44444444-4444-4444-4444-444444444002',
        '11111111-1111-1111-1111-111111111001',
        '22222222-2222-2222-2222-222222222001',
        'Pile-A2', 'aluminum_trihydrate', 6000.00, 2.42, TRUE
    ),
    (
        '44444444-4444-4444-4444-444444444003',
        '11111111-1111-1111-1111-111111111001',
        '22222222-2222-2222-2222-222222222001',
        'Pile-A3', 'bauxite', 5000.00, 2.55, TRUE
    ),
    -- Warehouse B — 2 piles
    (
        '44444444-4444-4444-4444-444444444004',
        '11111111-1111-1111-1111-111111111001',
        '22222222-2222-2222-2222-222222222002',
        'Pile-B1', 'aluminum_trihydrate', 7000.00, 2.42, TRUE
    ),
    (
        '44444444-4444-4444-4444-444444444005',
        '11111111-1111-1111-1111-111111111001',
        '22222222-2222-2222-2222-222222222002',
        'Pile-B2', 'coal', 4000.00, 0.85, TRUE
    ),
    -- Main Plant — 2 silos
    (
        '44444444-4444-4444-4444-444444444006',
        '11111111-1111-1111-1111-111111111002',
        '22222222-2222-2222-2222-222222222003',
        'Silo-1', 'cement', 12000.00, 1.50, TRUE
    ),
    (
        '44444444-4444-4444-4444-444444444007',
        '11111111-1111-1111-1111-111111111002',
        '22222222-2222-2222-2222-222222222003',
        'Silo-2', 'cement', 12000.00, 1.50, TRUE
    ),
    -- Storage Lot — 1 pile
    (
        '44444444-4444-4444-4444-444444444008',
        '11111111-1111-1111-1111-111111111002',
        '22222222-2222-2222-2222-222222222004',
        'Stack-1', 'limestone', 9000.00, 2.71, TRUE
    )
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Sensor readings (3 days of hourly baseline — combined temp/humidity)
-- One sensor per site, 72 readings each = 360 rows total.
-- Generated via generate_series so no application code is required.
-- ---------------------------------------------------------------------------
INSERT INTO sensor_readings (time, customer_id, site_id, sensor_id,
                              sensor_type, temperature_c, humidity_pct)
SELECT
    gs.t                                            AS time,
    s.customer_id,
    s.id                                            AS site_id,
    'SEED-SENSOR-' || LEFT(s.id::TEXT, 8)           AS sensor_id,
    'combined'                                      AS sensor_type,
    -- temperature: site-specific base + small sinusoidal diurnal cycle + noise
    ROUND((
        CASE s.id
            WHEN '22222222-2222-2222-2222-222222222001' THEN 22.0
            WHEN '22222222-2222-2222-2222-222222222002' THEN 23.5
            WHEN '22222222-2222-2222-2222-222222222003' THEN 19.0
            WHEN '22222222-2222-2222-2222-222222222004' THEN 19.5
            WHEN '22222222-2222-2222-2222-222222222005' THEN 21.0
        END
        + 2.0 * SIN(2 * PI() * EXTRACT(HOUR FROM gs.t) / 24)
        + (RANDOM() - 0.5) * 1.5
    )::NUMERIC, 2)                                  AS temperature_c,
    -- humidity: site-specific base + anti-phase to temperature + noise
    ROUND((
        CASE s.id
            WHEN '22222222-2222-2222-2222-222222222001' THEN 55.0
            WHEN '22222222-2222-2222-2222-222222222002' THEN 58.0
            WHEN '22222222-2222-2222-2222-222222222003' THEN 62.0
            WHEN '22222222-2222-2222-2222-222222222004' THEN 63.0
            WHEN '22222222-2222-2222-2222-222222222005' THEN 60.0
        END
        - 3.0 * SIN(2 * PI() * EXTRACT(HOUR FROM gs.t) / 24)
        + (RANDOM() - 0.5) * 2.0
    )::NUMERIC, 2)                                  AS humidity_pct
FROM sites s
CROSS JOIN generate_series(
    NOW() - INTERVAL '3 days',
    NOW(),
    INTERVAL '1 hour'
) AS gs(t)
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- Notification preferences — one catch-all rule per customer
-- ---------------------------------------------------------------------------
INSERT INTO notification_preferences
    (customer_id, alert_type, severity_threshold,
     email_enabled, sms_enabled, email_addresses,
     quiet_hours_start, quiet_hours_end)
VALUES
    (
        '11111111-1111-1111-1111-111111111001',
        'all', 'warning',
        TRUE, FALSE,
        ARRAY['ops@acme-minerals.example.com', 'alerts@acme-minerals.example.com'],
        '22:00', '07:00'
    ),
    (
        '11111111-1111-1111-1111-111111111002',
        'all', 'critical',
        TRUE, TRUE,
        ARRAY['ops@blueridge-cement.example.com'],
        NULL, NULL
    )
ON CONFLICT (customer_id, alert_type) DO NOTHING;
