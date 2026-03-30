/**
 * Alert REST endpoints.
 *
 * All routes require a valid JWT Bearer token.  The customerId is sourced
 * exclusively from the token — clients cannot access another tenant's data
 * regardless of the URL parameter they supply.
 *
 * Route order (most-specific first to avoid shadowing):
 *
 *   GET  /alerts/settings/:customerId   — get notification preferences + thresholds
 *   PUT  /alerts/settings/:customerId   — replace notification preferences + thresholds
 *   PUT  /alerts/:id/acknowledge        — mark alert acknowledged
 *   GET  /alerts/:customerId            — list alerts with filters + cursor pagination
 */

import { Router, Request, Response, NextFunction } from "express";
import { z }      from "zod";
import { authenticate }  from "../middleware/authenticate";
import { validate }      from "../middleware/validate";
import { AppError }      from "../middleware/errorHandler";
import { AlertRepository }                    from "../repositories/alertRepository";
import { NotificationPreferenceRepository }   from "../repositories/notificationPreferenceRepository";
import { AlertThresholdRepository }           from "../repositories/alertThresholdRepository";
import { ALERT_CATEGORIES, THRESHOLD_UNITS }  from "../repositories/alertThresholdRepository";
import { NOTIFICATION_CHANNELS }              from "../notifications/types";
import { ALERT_SEVERITIES }                   from "../types/alert";

export const alertsRouter = Router();
alertsRouter.use(authenticate);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Assert that the JWT customerId matches the URL :customerId param. */
function assertTenantMatch(jwtCustomerId: string, paramCustomerId: string): void {
  if (jwtCustomerId !== paramCustomerId) {
    throw new AppError(403, "Access denied", "FORBIDDEN");
  }
}

// ---------------------------------------------------------------------------
// GET /alerts/settings/:customerId
//
// Returns all notification preferences (contacts) and alert thresholds for the
// authenticated customer.  Both lists are returned in a single response so the
// settings UI can render the full page with one request.
//
// Response:
// {
//   "data": {
//     "preferences": [ NotificationPreference, ... ],
//     "thresholds":  [ AlertThreshold, ... ]
//   }
// }
// ---------------------------------------------------------------------------

const settingsParamsSchema = z.object({
  customerId: z.string().uuid("customerId must be a UUID"),
});

alertsRouter.get(
  "/alerts/settings/:customerId",
  validate.params(settingsParamsSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { customerId } = res.locals["auth"];
      const { customerId: paramId } = req.params as z.infer<typeof settingsParamsSchema>;
      assertTenantMatch(customerId, paramId);

      const preferenceRepo = res.locals["preferenceRepo"] as NotificationPreferenceRepository;
      const thresholdRepo  = res.locals["thresholdRepo"]  as AlertThresholdRepository;

      const [preferences, thresholds] = await Promise.all([
        preferenceRepo.findAll(customerId),
        thresholdRepo.findAll(customerId),
      ]);

      res.json({ data: { preferences, thresholds } });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// PUT /alerts/settings/:customerId
//
// Atomically replace the notification contacts and/or alert thresholds for the
// authenticated customer.  Both lists are optional in the request body —
// omitting a key leaves that configuration unchanged.
//
// Request body:
// {
//   "preferences": [
//     {
//       "id"?:             UUID (omit to create new),
//       "contactName":     string,
//       "contactEmail":    string | null,
//       "contactPhone":    string | null,
//       "channelsWarning": ["email","sms",...],
//       "channelsCritical":["email","sms",...],
//       "alertTypeFilter": string[] | null,
//       "siteIdFilter":    UUID[] | null,
//       "enabled":         boolean
//     },
//     ...
//   ],
//   "thresholds": [
//     {
//       "alertCategory":  "environmental" | "moisture" | "inventory",
//       "metric"?:        string (default ""),
//       "warningValue":   number,
//       "criticalValue":  number,
//       "unit":           "sigma" | "percent" | "volume",
//       "enabled"?:       boolean
//     },
//     ...
//   ]
// }
//
// Response: 200 { "data": { "preferences": [...], "thresholds": [...] } }
// ---------------------------------------------------------------------------

const contactUpsertSchema = z.object({
  id:               z.string().uuid().optional(),
  contactName:      z.string().min(1).max(200),
  contactEmail:     z.string().email().nullable().default(null),
  contactPhone:     z.string().max(30).nullable().default(null),
  channelsWarning:  z.array(z.enum(NOTIFICATION_CHANNELS)).default([]),
  channelsCritical: z.array(z.enum(NOTIFICATION_CHANNELS)).default([]),
  alertTypeFilter:  z.array(z.string().min(1)).nullable().default(null),
  siteIdFilter:     z.array(z.string().uuid()).nullable().default(null),
  enabled:          z.boolean().default(true),
});

const thresholdUpsertSchema = z.object({
  alertCategory: z.enum(ALERT_CATEGORIES),
  metric:        z.string().max(100).optional(),
  warningValue:  z.number().finite(),
  criticalValue: z.number().finite(),
  unit:          z.enum(THRESHOLD_UNITS),
  enabled:       z.boolean().optional(),
});

const settingsBodySchema = z.object({
  preferences: z.array(contactUpsertSchema).optional(),
  thresholds:  z.array(thresholdUpsertSchema).optional(),
}).refine(
  (v: { preferences?: unknown; thresholds?: unknown }) => v.preferences !== undefined || v.thresholds !== undefined,
  { message: "At least one of 'preferences' or 'thresholds' must be provided" },
);

alertsRouter.put(
  "/alerts/settings/:customerId",
  validate.params(settingsParamsSchema),
  validate.body(settingsBodySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { customerId } = res.locals["auth"];
      const { customerId: paramId } = req.params as z.infer<typeof settingsParamsSchema>;
      assertTenantMatch(customerId, paramId);

      const body           = req.body as z.infer<typeof settingsBodySchema>;
      const preferenceRepo = res.locals["preferenceRepo"] as NotificationPreferenceRepository;
      const thresholdRepo  = res.locals["thresholdRepo"]  as AlertThresholdRepository;

      // Run updates in parallel when both are provided.
      const [preferences, thresholds] = await Promise.all([
        body.preferences !== undefined
          ? preferenceRepo.replaceAll(customerId, body.preferences)
          : preferenceRepo.findAll(customerId),
        body.thresholds !== undefined
          ? thresholdRepo.upsertMany(customerId, body.thresholds)
          : thresholdRepo.findAll(customerId),
      ]);

      res.json({ data: { preferences, thresholds } });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// PUT /alerts/:id/acknowledge
//
// Mark an alert as acknowledged.  Idempotent — re-acknowledging overwrites the
// previous acknowledgement.
//
// Request body:
// {
//   "note"?: string (max 1000 chars, optional)
// }
//
// Response: 200 { "data": Alert } | 404 { "error": { code, message } }
// ---------------------------------------------------------------------------

const acknowledgeParamsSchema = z.object({
  id: z.string().uuid("id must be a UUID"),
});

const acknowledgeBodySchema = z.object({
  note: z.string().max(1_000).optional(),
});

alertsRouter.put(
  "/alerts/:id/acknowledge",
  validate.params(acknowledgeParamsSchema),
  validate.body(acknowledgeBodySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { customerId, userId } = res.locals["auth"];
      const { id }   = req.params as z.infer<typeof acknowledgeParamsSchema>;
      const { note } = req.body   as z.infer<typeof acknowledgeBodySchema>;

      const alertRepo = res.locals["alertRepo"] as AlertRepository;
      const alert     = await alertRepo.acknowledge(customerId, id, userId, note);

      if (!alert) {
        throw new AppError(404, "Alert not found", "NOT_FOUND");
      }

      res.json({ data: alert });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /alerts/:customerId
//
// List alerts for the authenticated tenant with filtering and cursor-based
// pagination (newest-first).
//
// Query parameters:
//   from        ISO 8601 start of window (default: 24 h ago)
//   to          ISO 8601 end of window   (default: now)
//   siteId      UUID — filter to a specific site              (optional)
//   severity    "warning" | "critical"                        (optional)
//   alertType   e.g. "temperature_high", "pile_volume_drop"   (optional)
//   source      Originating service, e.g. "environment-service" (optional)
//   entityId    Sensor/pile identifier                        (optional)
//   before      ISO 8601 cursor — items older than this timestamp (next page)
//   limit       1–500, default 50
//
// Response:
// {
//   "data": [ Alert, ... ],
//   "count": 42,
//   "meta": {
//     "from": "...", "to": "...", "limit": 50,
//     "nextCursor": "<ISO receivedAt of last item> | null"
//   }
// }
// ---------------------------------------------------------------------------

const listParamsSchema = z.object({
  customerId: z.string().uuid("customerId must be a UUID"),
});

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
  (v: { from?: Date; to?: Date }) => !v.from || !v.to || v.from < v.to,
  { message: "'from' must be earlier than 'to'", path: ["from"] },
);

alertsRouter.get(
  "/alerts/:customerId",
  validate.params(listParamsSchema),
  validate.query(listQuerySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { customerId } = res.locals["auth"];
      const { customerId: paramId } = req.params as z.infer<typeof listParamsSchema>;
      assertTenantMatch(customerId, paramId);

      const alertRepo = res.locals["alertRepo"] as AlertRepository;
      const q         = req.query as unknown as z.infer<typeof listQuerySchema>;

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
          from:       (q.from ?? defaultFrom).toISOString(),
          to:         (q.to   ?? new Date()).toISOString(),
          limit:      q.limit,
          nextCursor,
        },
      });
    } catch (err) {
      next(err);
    }
  },
);
