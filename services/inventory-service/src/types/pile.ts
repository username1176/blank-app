import { z } from "zod";

// ---------------------------------------------------------------------------
// Domain type  (camelCase, JS-native values)
// ---------------------------------------------------------------------------

export interface Pile {
  id:                 string;
  customerId:         string;
  siteId:             string;
  name:               string;
  materialType:       string;
  /** WKB hex string from PostGIS; use ST_AsGeoJSON in the query for GeoJSON. */
  footprint:          string | null;
  maxCapacityTonnes:  number | null;
  bulkDensityT_m3:    number | null;
  isActive:           boolean;
  createdAt:          Date;
  updatedAt:          Date;
}

// ---------------------------------------------------------------------------
// Raw DB row  (snake_case, pg wire types)
// NUMERIC columns arrive as strings from the pg driver.
// ---------------------------------------------------------------------------

export interface PileRow {
  id:                   string;
  customer_id:          string;
  site_id:              string;
  name:                 string;
  material_type:        string;
  footprint:            string | null;
  max_capacity_tonnes:  string | null;
  bulk_density_t_m3:    string | null;
  is_active:            boolean;
  created_at:           Date;
  updated_at:           Date;
}

// ---------------------------------------------------------------------------
// Input schemas (Zod-validated at the service / route layer)
// ---------------------------------------------------------------------------

export const createPileSchema = z.object({
  siteId:              z.string().uuid(),
  name:                z.string().min(1).max(255),
  materialType:        z.string().min(1).max(100),
  maxCapacityTonnes:   z.number().positive().nullable().optional(),
  bulkDensityT_m3:     z.number().positive().nullable().optional(),
});

export type CreatePileInput = z.infer<typeof createPileSchema>;

export const updatePileSchema = z.object({
  name:               z.string().min(1).max(255).optional(),
  materialType:       z.string().min(1).max(100).optional(),
  maxCapacityTonnes:  z.number().positive().nullable().optional(),
  bulkDensityT_m3:    z.number().positive().nullable().optional(),
  isActive:           z.boolean().optional(),
}).refine(
  (v) => Object.keys(v).length > 0,
  { message: "At least one field must be provided for update" },
);

export type UpdatePileInput = z.infer<typeof updatePileSchema>;

// ---------------------------------------------------------------------------
// Query options
// ---------------------------------------------------------------------------

export interface FindPilesOptions {
  activeOnly?: boolean;  // default: true
}
