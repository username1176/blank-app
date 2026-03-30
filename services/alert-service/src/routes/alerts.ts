/**
 * Alert query endpoints.
 *
 * All routes require a valid JWT Bearer token.  The customerId from the token
 * is the exclusive source of tenant scoping — clients cannot request another
 * tenant's alerts regardless of what parameters they supply.
 *
 * GET  /alerts           List alerts with filtering and cursor-based pagination
 * GET  /alerts/:id       Fetch a single alert by ID
 */

import { Router } from "express";
import { z } from "zod";
import { authenticate } from "../middleware/authenticate";
import { validate } from "../middleware/validate";
import { AppError } from "../middleware/errorHandler";
import { AlertRepository } from "../repositories/alertRepository";
import { ALERT_SEVERITIES } from "../types/alert";

export const alertsRouter = Router();
alertsRouter.use(authenticate);

// ── GET /alerts ───────────────────────────────────────────────────────────────

/**
 * List alerts for the authenticated tenant.
 *
 * Query parameters:
 *   from        ISO 8601 start of window (default: 24 h ago)
 *   to          ISO 8601 end of window   (default: now)
 *   siteId      UUID — filter to a specific site              (optional)
 *   severity    "warning" | "critical"                        (optional)
 *   alertType   e.g. "temperature_high", "pile_volume_drop"   (optional)
 *   source      Originating service name, e.g. "environment-service" (optional)
 *   entityId    Sensor/pile identifier                        (optional)
 *   before      ISO 8601 cursor — return records older than this timestamp
 *               (use the receivedAt of the last item for the next page)
 *   limit       1–500, default 50
 *
 * Response:
 * {
 *   "data": [ Alert, ... ],
 *   "count": 42,
 *   "meta": {
 *     "from": "...", "to": "...", "limit": 50,
 *     "nextCursor": "<ISO receivedAt of last item> | null"
 *   }
 * }
 */
const listQuerySchema = z.object({
  from:      z.coerce.date().optional(),
  to:        z.coerce.date().optional(),
  siteId:    z.string().uuid().optional(),
  severity:  z.enum(ALERT_SEVERITIES).optional(),
  alertType: z.string().min(1).optional(),
  source:    z.string().min(1).optional(),
  entityId:  z.string().min(1).optional(),
  before:    z.coerce.date().optional(),
  limit:     z.coerce.number().int().min(1).max(500).default(50),
}).refine(
  (v) => !v.from || !v.to || v.from < v.to,
  { message: "'from' must be earlier than 'to'", path: ["from"] },
);

alertsRouter.get(
  "/alerts",
  validate.query(listQuerySchema),
  async (req, res, next) => {
    try {
      const { customerId } = res.locals["auth"];
      const alertRepo      = res.locals["alertRepo"] as AlertRepository;
      const q              = req.query as unknown as z.infer<typeof listQuerySchema>;

      const alerts = await alertRepo.findAll(customerId, {
        from:      q.from,
        to:        q.to,
        siteId:    q.siteId,
        severity:  q.severity,
        alertType: q.alertType,
        source:    q.source,
        entityId:  q.entityId,
        before:    q.before,
        limit:     q.limit,
      });

      const defaultFrom = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const nextCursor  = alerts.length === q.limit
        ? (alerts[alerts.length - 1]?.receivedAt.toISOString() ?? null)
        : null;

      res.json({
        data:  alerts,
        count: alerts.length,
        meta: {
          from:       (q.from  ?? defaultFrom).toISOString(),
          to:         (q.to    ?? new Date()).toISOString(),
          limit:      q.limit,
          nextCursor,
        },
      });
    } catch (err) {
      next(err);
    }
  },
);

// ── GET /alerts/:id ───────────────────────────────────────────────────────────

/**
 * Fetch a single alert by its UUID.
 *
 * Returns 404 when the ID does not exist or belongs to a different tenant
 * (both cases look identical to the caller — no information is leaked).
 *
 * Response: 200 { data: Alert } | 404 { error: { code, message } }
 */
const alertIdParamsSchema = z.object({
  id: z.string().uuid("id must be a UUID"),
});

alertsRouter.get(
  "/alerts/:id",
  validate.params(alertIdParamsSchema),
  async (req, res, next) => {
    try {
      const { customerId } = res.locals["auth"];
      const alertRepo      = res.locals["alertRepo"] as AlertRepository;
      const { id }         = req.params as z.infer<typeof alertIdParamsSchema>;

      const alert = await alertRepo.findById(customerId, id);
      if (!alert) {
        throw new AppError(404, "Alert not found", "NOT_FOUND");
      }

      res.json({ data: alert });
    } catch (err) {
      next(err);
    }
  },
);
