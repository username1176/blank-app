import { z } from "zod";

// ---------------------------------------------------------------------------
// Measurement source enum
// ---------------------------------------------------------------------------

export const MEASUREMENT_SOURCES = ["camera", "manual", "edge_sensor"] as const;
export type MeasurementSource = typeof MEASUREMENT_SOURCES[number];

// ---------------------------------------------------------------------------
// Domain type
// ---------------------------------------------------------------------------

export interface InventorySnapshot {
  time:               Date;
  customerId:         string;
  siteId:             string;
  pileId:             string;
  cameraId:           string | null;
  volumeM3:           number;
  estimatedTonnes:    number | null;
  heightM:            number | null;
  surfaceAreaM2:      number | null;
  confidenceScore:    number | null;
  measurementSource:  MeasurementSource;
  rawImagePath:       string | null;
  createdAt:          Date;
}

// ---------------------------------------------------------------------------
// Raw DB row
// ---------------------------------------------------------------------------

export interface SnapshotRow {
  time:                Date;
  customer_id:         string;
  site_id:             string;
  pile_id:             string;
  camera_id:           string | null;
  volume_m3:           string;
  estimated_tonnes:    string | null;
  height_m:            string | null;
  surface_area_m2:     string | null;
  confidence_score:    string | null;
  measurement_source:  MeasurementSource;
  raw_image_path:      string | null;
  created_at:          Date;
}

// ---------------------------------------------------------------------------
// Continuous aggregate row types
// ---------------------------------------------------------------------------

export interface HourlyAggregateRow {
  bucket:           Date;
  customer_id:      string;
  site_id:          string;
  pile_id:          string;
  avg_volume_m3:    string;
  min_volume_m3:    string;
  max_volume_m3:    string;
  avg_tonnes:       string | null;
  min_tonnes:       string | null;
  max_tonnes:       string | null;
  sample_count:     string;
}

export interface DailyAggregateRow {
  bucket:           Date;
  customer_id:      string;
  site_id:          string;
  pile_id:          string;
  avg_volume_m3:    string;
  min_volume_m3:    string;
  max_volume_m3:    string;
  avg_tonnes:       string | null;
  min_tonnes:       string | null;
  max_tonnes:       string | null;
  sample_count:     string;
}

// ---------------------------------------------------------------------------
// Domain aggregate types
// ---------------------------------------------------------------------------

export interface HourlyAggregate {
  bucket:         Date;
  customerId:     string;
  siteId:         string;
  pileId:         string;
  avgVolumeM3:    number;
  minVolumeM3:    number;
  maxVolumeM3:    number;
  avgTonnes:      number | null;
  minTonnes:      number | null;
  maxTonnes:      number | null;
  sampleCount:    number;
}

export interface DailyAggregate {
  bucket:         Date;
  customerId:     string;
  siteId:         string;
  pileId:         string;
  avgVolumeM3:    number;
  minVolumeM3:    number;
  maxVolumeM3:    number;
  avgTonnes:      number | null;
  minTonnes:      number | null;
  maxTonnes:      number | null;
  sampleCount:    number;
}

// Inline drop detection result
export interface DropDetection {
  pileId:           string;
  currentVolumeM3:  number;
  referenceVolumeM3: number;
  dropPct:          number;
  detectedAt:       Date;
}

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------

export const createSnapshotSchema = z.object({
  time:              z.coerce.date().optional(),   // defaults to now() when omitted
  customerId:        z.string().uuid(),
  siteId:            z.string().uuid(),
  pileId:            z.string().uuid(),
  cameraId:          z.string().uuid().nullable().optional(),
  volumeM3:          z.number().nonnegative(),
  estimatedTonnes:   z.number().nonnegative().nullable().optional(),
  heightM:           z.number().nonnegative().nullable().optional(),
  surfaceAreaM2:     z.number().nonnegative().nullable().optional(),
  confidenceScore:   z.number().min(0).max(1).nullable().optional(),
  measurementSource: z.enum(MEASUREMENT_SOURCES).default("camera"),
  rawImagePath:      z.string().nullable().optional(),
});

export type CreateSnapshotInput = z.infer<typeof createSnapshotSchema>;

// ---------------------------------------------------------------------------
// Time-range query options
// ---------------------------------------------------------------------------

export interface TimeRangeOptions {
  from:   Date;
  to:     Date;
  limit?: number;    // default: 1000
  order?: "asc" | "desc";   // default: "desc"
}
