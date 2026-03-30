/**
 * Sensor REST endpoints.
 *
 * All routes require a valid JWT (Bearer token) — tenant isolation is enforced
 * by taking customerId from the verified token payload, never from the request.
 *
 * Route summary
 * ─────────────
 *  POST /sensors/reading            Ingest a single sensor reading
 *  POST /sensors/readings           Alias for the above (kept for back-compat)
 *  POST /sensors/readings/batch     Ingest up to 500 readings in one call
 *
 *  GET  /sensors/:siteId/current    Latest reading per sensor at a site
 *  GET  /sensors/:siteId/latest     Alias for /current (back-compat)
 *  GET  /sensors/:siteId/history    Time-series readings with date-range filter
 *  GET  /sensors/:siteId/anomalies  Recent anomaly events detected at a site
 */

import { Router } from "express";
import { z } from "zod";
import { authenticate } from "../middleware/authenticate";
import { validate } from "../middleware/validate";
import { AnomalyDetector } from "../anomaly/detector";
import { AnomalyRepository } from "../repositories/anomalyRepository";
import { SensorReadingRepository } from "../repositories/sensorReadingRepository";
import {
  SENSOR_TYPES,
  createSensorReadingSchema,
  batchSensorReadingSchema,
} from "../types/sensorReading";

export const sensorsRouter = Router();
sensorsRouter.use(authenticate);

// ── Shared param / query schemas ──────────────────────────────────────────────

const siteIdParamsSchema = z.object({
  siteId: z.string().uuid("siteId must be a UUID"),
});

// ── Helper — fire anomaly check without blocking the response ─────────────────

function fireAnomalyCheck(
  detector: AnomalyDetector | null,
  reading: {
    customerId:  string;
    siteId:      string;
    sensorId:    string;
    sensorType:  string;
    temperatureC: number | null | undefined;
    humidityPct:  number | null | undefined;
  },
): void {
  if (!detector) return;
  detector
    .check({
      customerId:  reading.customerId,
      siteId:      reading.siteId,
      sensorId:    reading.sensorId,
      sensorType:  reading.sensorType,
      temperatureC: reading.temperatureC ?? null,
      humidityPct:  reading.humidityPct  ?? null,
    })
    .catch(() => {/* errors logged inside detector */});
}

// ── POST /sensors/reading ─────────────────────────────────────────────────────

/**
 * Ingest a single sensor reading via REST.
 *
 * Body:     CreateSensorReadingInput
 * Response: 201 { data: SensorReading }
 *
 * The customerId is taken from the verified JWT — callers cannot forge it.
 * After a successful insert the reading is checked for anomalies asynchronously
 * (fire-and-forget) so the HTTP response is never delayed by detection logic.
 */
async function handleSingleIngest(
  req: Parameters<Parameters<typeof sensorsRouter.post>[1]>[0],
  res: Parameters<Parameters<typeof sensorsRouter.post>[1]>[1],
  next: Parameters<Parameters<typeof sensorsRouter.post>[1]>[2],
): Promise<void> {
  try {
    const { customerId }  = res.locals["auth"];
    const sensorRepo      = res.locals["sensorRepo"] as SensorReadingRepository;
    const anomalyDetector = res.locals["anomalyDetector"] as AnomalyDetector | null;
    const body            = req.body as z.infer<typeof createSensorReadingSchema>;

    const reading = await sensorRepo.insert(customerId, body);
    res.status(201).json({ data: reading });

    fireAnomalyCheck(anomalyDetector, {
      customerId,
      siteId:      body.siteId,
      sensorId:    body.sensorId,
      sensorType:  body.sensorType,
      temperatureC: body.temperatureC,
      humidityPct:  body.humidityPct,
    });
  } catch (err) {
    next(err);
  }
}

sensorsRouter.post("/sensors/reading",  validate.body(createSensorReadingSchema), handleSingleIngest);
sensorsRouter.post("/sensors/readings", validate.body(createSensorReadingSchema), handleSingleIngest);

// ── POST /sensors/readings/batch ──────────────────────────────────────────────

/**
 * Ingest up to 500 readings in a single request.
 *
 * Body:     { readings: CreateSensorReadingInput[] }
 * Response: 201 { data: { inserted: number } }
 *
 * All readings are persisted in one tenant-scoped transaction.
 * Anomaly checks are fired for each reading after the response is sent.
 */
sensorsRouter.post(
  "/sensors/readings/batch",
  validate.body(batchSensorReadingSchema),
  async (req, res, next) => {
    try {
      const { customerId }  = res.locals["auth"];
      const sensorRepo      = res.locals["sensorRepo"] as SensorReadingRepository;
      const anomalyDetector = res.locals["anomalyDetector"] as AnomalyDetector | null;
      const { readings }    = req.body as z.infer<typeof batchSensorReadingSchema>;

      const inserted = await sensorRepo.insertBatch(customerId, readings);
      res.status(201).json({ data: { inserted } });

      for (const r of readings) {
        fireAnomalyCheck(anomalyDetector, {
          customerId,
          siteId:      r.siteId,
          sensorId:    r.sensorId,
          sensorType:  r.sensorType,
          temperatureC: r.temperatureC,
          humidityPct:  r.humidityPct,
        });
      }
    } catch (err) {
      next(err);
    }
  },
);

// ── GET /sensors/:siteId/current ─────────────────────────────────────────────

/**
 * Return the most recent reading for every sensor at a site.
 *
 * Response: 200 { data: SensorReading[], count: number }
 *
 * Useful for a live dashboard "current state" view — one row per sensor,
 * each showing the last reported value and timestamp.
 */
async function handleCurrentReadings(
  req: Parameters<Parameters<typeof sensorsRouter.get>[1]>[0],
  res: Parameters<Parameters<typeof sensorsRouter.get>[1]>[1],
  next: Parameters<Parameters<typeof sensorsRouter.get>[1]>[2],
): Promise<void> {
  try {
    const { customerId } = res.locals["auth"];
    const sensorRepo     = res.locals["sensorRepo"] as SensorReadingRepository;
    const { siteId }     = req.params as z.infer<typeof siteIdParamsSchema>;

    const readings = await sensorRepo.findLatestPerSite(customerId, siteId);
    res.json({ data: readings, count: readings.length });
  } catch (err) {
    next(err);
  }
}

sensorsRouter.get("/sensors/:siteId/current", validate.params(siteIdParamsSchema), handleCurrentReadings);
sensorsRouter.get("/sensors/:siteId/latest",  validate.params(siteIdParamsSchema), handleCurrentReadings);

// ── GET /sensors/:siteId/history ─────────────────────────────────────────────

/**
 * Fetch time-series readings within a date-range window.
 *
 * Query parameters:
 *   from        ISO 8601 datetime — start of window (inclusive, required)
 *   to          ISO 8601 datetime — end of window   (exclusive, required)
 *   sensorId    Filter to a specific sensor           (optional)
 *   sensorType  Filter by sensor type                 (optional)
 *   limit       Max rows to return (1-1000, default 500)
 *
 * When sensorId is provided the query targets a single sensor; when omitted
 * results span all sensors at the site (subject to limit).
 *
 * Response: 200 { data: SensorReading[], count: number, meta: {...} }
 */
const historyQuerySchema = z
  .object({
    from:       z.coerce.date(),
    to:         z.coerce.date(),
    sensorId:   z.string().min(1).optional(),
    sensorType: z.enum(SENSOR_TYPES).optional(),
    limit:      z.coerce.number().int().min(1).max(1000).default(500),
  })
  .refine((v) => v.from < v.to, {
    message: "'from' must be earlier than 'to'",
    path:    ["from"],
  });

sensorsRouter.get(
  "/sensors/:siteId/history",
  validate.params(siteIdParamsSchema),
  validate.query(historyQuerySchema),
  async (req, res, next) => {
    try {
      const { customerId } = res.locals["auth"];
      const sensorRepo     = res.locals["sensorRepo"] as SensorReadingRepository;
      const { siteId }     = req.params as z.infer<typeof siteIdParamsSchema>;
      const { from, to, sensorId, sensorType, limit } =
        req.query as unknown as z.infer<typeof historyQuerySchema>;

      let readings;
      if (sensorId !== undefined) {
        // Single-sensor time series
        readings = await sensorRepo.findRange(customerId, sensorId, from, to, limit);
      } else {
        // All sensors at the site
        readings = await sensorRepo.findRangeBySite(customerId, siteId, from, to, {
          sensorType,
          limit,
        });
      }

      res.json({
        data:  readings,
        count: readings.length,
        meta: {
          siteId,
          sensorId:   sensorId ?? null,
          sensorType: sensorType ?? null,
          from: from.toISOString(),
          to:   to.toISOString(),
          limit,
        },
      });
    } catch (err) {
      next(err);
    }
  },
);

// ── GET /sensors/:siteId/anomalies ────────────────────────────────────────────

/**
 * List recent anomaly events detected at a site.
 *
 * Query parameters:
 *   from      ISO 8601 start of window (default: 24 h ago)
 *   to        ISO 8601 end of window   (default: now)
 *   sensorId  Filter to a specific sensor        (optional)
 *   severity  "warning" | "critical"             (optional)
 *   limit     Max rows (1-1000, default 100)
 *
 * Anomalies are written to the DB by the anomaly detector module after each
 * successful Kafka publish, so this endpoint does not require a Kafka consumer.
 *
 * Response: 200 { data: StoredAnomaly[], count: number, meta: {...} }
 *           200 { data: [], count: 0, meta: {...} }  when module is disabled
 */
const anomaliesQuerySchema = z.object({
  from:     z.coerce.date().optional(),
  to:       z.coerce.date().optional(),
  sensorId: z.string().min(1).optional(),
  severity: z.enum(["warning", "critical"] as const).optional(),
  limit:    z.coerce.number().int().min(1).max(1000).default(100),
});

sensorsRouter.get(
  "/sensors/:siteId/anomalies",
  validate.params(siteIdParamsSchema),
  validate.query(anomaliesQuerySchema),
  async (req, res, next) => {
    try {
      const { customerId } = res.locals["auth"];
      const anomalyRepo    = res.locals["anomalyRepo"] as AnomalyRepository | null;
      const { siteId }     = req.params as z.infer<typeof siteIdParamsSchema>;
      const { from, to, sensorId, severity, limit } =
        req.query as unknown as z.infer<typeof anomaliesQuerySchema>;

      // Anomaly detection may be disabled (ANOMALY_ENABLED=false).
      if (!anomalyRepo) {
        res.json({
          data:  [],
          count: 0,
          meta: { siteId, anomalyDetectionEnabled: false },
        });
        return;
      }

      const anomalies = await anomalyRepo.findBySite(customerId, siteId, {
        from,
        to,
        sensorId,
        severity,
        limit,
      });

      const defaultFrom = new Date(Date.now() - 24 * 60 * 60 * 1000);
      res.json({
        data:  anomalies,
        count: anomalies.length,
        meta: {
          siteId,
          sensorId:  sensorId ?? null,
          severity:  severity ?? null,
          from: (from ?? defaultFrom).toISOString(),
          to:   (to   ?? new Date()).toISOString(),
          limit,
          anomalyDetectionEnabled: true,
        },
      });
    } catch (err) {
      next(err);
    }
  },
);
