import { Router } from "express";
import { z } from "zod";
import { authenticate } from "../middleware/authenticate";
import { validate } from "../middleware/validate";
import { AppError } from "../middleware/errorHandler";
import { SensorReadingRepository } from "../repositories/sensorReadingRepository";
import {
  createSensorReadingSchema,
  batchSensorReadingSchema,
} from "../types/sensorReading";

export const sensorsRouter = Router();
sensorsRouter.use(authenticate);

// ── Param schemas ─────────────────────────────────────────────────────────────

const siteIdParamsSchema = z.object({
  siteId: z.string().uuid("siteId must be a UUID"),
});

// ── POST /sensors/readings ────────────────────────────────────────────────────

/**
 * Ingest a single sensor reading via REST.
 *
 * Body: CreateSensorReadingInput
 * Response: 201 { data: SensorReading }
 *
 * The customerId is taken from the verified JWT — the caller cannot forge it
 * through the request body.
 */
sensorsRouter.post(
  "/sensors/readings",
  validate.body(createSensorReadingSchema),
  async (req, res, next) => {
    try {
      const { customerId } = res.locals["auth"];
      const sensorRepo     = res.locals["sensorRepo"] as SensorReadingRepository;
      const body           = req.body as z.infer<typeof createSensorReadingSchema>;

      const reading = await sensorRepo.insert(customerId, body);
      res.status(201).json({ data: reading });
    } catch (err) {
      next(err);
    }
  },
);

// ── POST /sensors/readings/batch ──────────────────────────────────────────────

/**
 * Ingest up to 500 readings in a single request.
 *
 * Body: { readings: CreateSensorReadingInput[] }
 * Response: 201 { data: { inserted: number } }
 *
 * Uses a single DB transaction — all readings share the tenant GUC.
 */
sensorsRouter.post(
  "/sensors/readings/batch",
  validate.body(batchSensorReadingSchema),
  async (req, res, next) => {
    try {
      const { customerId } = res.locals["auth"];
      const sensorRepo     = res.locals["sensorRepo"] as SensorReadingRepository;
      const { readings }   = req.body as z.infer<typeof batchSensorReadingSchema>;

      const inserted = await sensorRepo.insertBatch(customerId, readings);
      res.status(201).json({ data: { inserted } });
    } catch (err) {
      next(err);
    }
  },
);

// ── GET /sensors/:siteId/latest ───────────────────────────────────────────────

/**
 * Return the most recent reading for every sensor at a site.
 *
 * Response: 200 { data: SensorReading[], count: number }
 */
sensorsRouter.get(
  "/sensors/:siteId/latest",
  validate.params(siteIdParamsSchema),
  async (req, res, next) => {
    try {
      const { customerId } = res.locals["auth"];
      const sensorRepo     = res.locals["sensorRepo"] as SensorReadingRepository;
      const { siteId }     = req.params as z.infer<typeof siteIdParamsSchema>;

      const readings = await sensorRepo.findLatestPerSite(customerId, siteId);
      res.json({ data: readings, count: readings.length });
    } catch (err) {
      next(err);
    }
  },
);

// ── GET /sensors/:siteId/history ─────────────────────────────────────────────

/**
 * Fetch raw readings for a specific sensor within a time window.
 *
 * Query: { sensorId (required), from (ISO), to (ISO), limit? (1-1000) }
 * Response: 200 { data: SensorReading[], count: number }
 */
const historyQuerySchema = z.object({
  sensorId: z.string().min(1),
  from:     z.coerce.date(),
  to:       z.coerce.date(),
  limit:    z.coerce.number().int().min(1).max(1000).default(500),
}).refine((v) => v.from < v.to, {
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
      const { sensorId, from, to, limit } = req.query as unknown as z.infer<typeof historyQuerySchema>;

      const readings = await sensorRepo.findRange(customerId, sensorId, from, to, limit);
      res.json({
        data: readings,
        count: readings.length,
        meta: {
          siteId, sensorId,
          from: from.toISOString(),
          to:   to.toISOString(),
        },
      });
    } catch (err) {
      next(err);
    }
  },
);
