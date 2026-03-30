-- =============================================================================
-- U2: Undo V2 — drop core reference tables
-- =============================================================================
-- Drop in reverse dependency order: piles and cameras reference sites which
-- references customers.  CASCADE handles any remaining FK dependents.

DROP TABLE IF EXISTS piles     CASCADE;
DROP TABLE IF EXISTS cameras   CASCADE;
DROP TABLE IF EXISTS sites     CASCADE;
DROP TABLE IF EXISTS customers CASCADE;
