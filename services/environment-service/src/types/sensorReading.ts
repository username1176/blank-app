import { z } from "zod";

// ---------------------------------------------------------------------------
// Sensor type enum — mirrors sensor_readings.sensor_type CHECK constraint
// ---------------------------------------------------------------------------

export const SENSOR_TYPES = ["temperature", "humidity", "combined", "pressure", "co2"] as const;
export type SensorType = typeof SENSOR_TYPES[number];

// ---------------------------------------------------------------------------
// Domain type (camelCase, JS-native values)
// ---------------------------------------------------------------------------

export interface SensorReading {
  time:               Date;
  customerId:         string;
  siteId:             string;
  sensorId:           string;   // device identifier — TEXT, not UUID
  sensorType:         SensorType;
  temperatureC:       number | null;
  humidityPct:        number | null;
  pressureHpa:        number | null;
  co2Ppm:             number | null;
  batteryPct:         number | null;
  signalStrengthDbm:  number | null;
  createdAt:          Date;
}

// ---------------------------------------------------------------------------
// Raw DB row (snake_case, NUMERIC columns arrive as strings from pg)
// ---------------------------------------------------------------------------

export interface SensorReadingRow {
  time:                Date;
  customer_id:         string;
  site_id:             string;
  sensor_id:           string;
  sensor_type:         SensorType;
  temperature_c:       string | null;
  humidity_pct:        string | null;
  pressure_hpa:        string | null;
  co2_ppm:             string | null;
  battery_pct:         string | null;
  signal_strength_dbm: string | null;
  created_at:          Date;
}

// ---------------------------------------------------------------------------
// REST ingest schemas
// ---------------------------------------------------------------------------

// Single reading posted by an authenticated API client
export const createSensorReadingSchema = z.object({
  siteId:             z.string().uuid("siteId must be a UUID"),
  sensorId:           z.string().min(1).max(128),
  sensorType:         z.enum(SENSOR_TYPES),
  temperatureC:       z.number().min(-80).max(100).nullable().optional(),
  humidityPct:        z.number().min(0).max(100).nullable().optional(),
  pressureHpa:        z.number().min(800).max(1100).nullable().optional(),
  co2Ppm:             z.number().min(0).max(10_000).nullable().optional(),
  batteryPct:         z.number().min(0).max(100).nullable().optional(),
  signalStrengthDbm:  z.number().min(-120).max(0).nullable().optional(),
  // If omitted the DB defaults to NOW()
  time:               z.coerce.date().optional(),
}).refine(
  (v) =>
    v.temperatureC != null ||
    v.humidityPct  != null ||
    v.pressureHpa  != null ||
    v.co2Ppm       != null,
  { message: "At least one measurement value must be provided" },
);

export type CreateSensorReadingInput = z.infer<typeof createSensorReadingSchema>;

// Batch endpoint — up to 500 readings per call
export const batchSensorReadingSchema = z.object({
  readings: z
    .array(createSensorReadingSchema)
    .min(1, "readings array must not be empty")
    .max(500, "Maximum 500 readings per batch"),
});

export type BatchSensorReadingInput = z.infer<typeof batchSensorReadingSchema>;

// ---------------------------------------------------------------------------
// MQTT payload schema
// ---------------------------------------------------------------------------
// Published by IoT sensors to:
//   {prefix}/{customerId}/site/{siteId}/sensor/{sensorId}/readings
//
// The customerId and siteId come from the topic; the payload only carries
// measurement values and optional device-health fields.
// ---------------------------------------------------------------------------

export const mqttPayloadSchema = z.object({
  sensor_type:         z.enum(SENSOR_TYPES),
  temperature_c:       z.number().min(-80).max(100).nullable().optional(),
  humidity_pct:        z.number().min(0).max(100).nullable().optional(),
  pressure_hpa:        z.number().min(800).max(1100).nullable().optional(),
  co2_ppm:             z.number().min(0).max(10_000).nullable().optional(),
  battery_pct:         z.number().min(0).max(100).nullable().optional(),
  signal_strength_dbm: z.number().min(-120).max(0).nullable().optional(),
  // Optional ISO 8601 timestamp; omit to use server time
  timestamp:           z.string().datetime().optional(),
}).refine(
  (v) =>
    v.temperature_c != null ||
    v.humidity_pct  != null ||
    v.pressure_hpa  != null ||
    v.co2_ppm       != null,
  { message: "At least one measurement value must be provided" },
);

export type MqttPayload = z.infer<typeof mqttPayloadSchema>;
