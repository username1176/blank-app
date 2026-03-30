import { Router } from "express";
import { z } from "zod";
import { authenticate } from "../middleware/authenticate";
import { validate } from "../middleware/validate";
import { AppError } from "../middleware/errorHandler";
import { PileReconciliationRow } from "../types/inventorySnapshot";
import { InventorySnapshotRepository } from "../repositories/inventorySnapshotRepository";
import { toFloat, toFloatOrNull } from "../db/parse";

export const inventoryRouter = Router();
inventoryRouter.use(authenticate);

// ── Shared param/query schemas ────────────────────────────────────────────────

const siteIdParamsSchema = z.object({
  siteId: z.string().uuid("siteId must be a UUID"),
});

const pileIdParamsSchema = z.object({
  pileId: z.string().uuid("pileId must be a UUID"),
});

// ── GET /inventory/reconciliation/:siteId ─────────────────────────────────────

/**
 * Compare expected (manual measurement) vs actual (camera measurement) volume
 * for every active pile at a site.
 *
 * Response: 200 { data: ReconciliationReport }
 *
 * discrepancyM3  = cameraVolumeM3 - manualVolumeM3
 * discrepancyPct = discrepancyM3  / manualVolumeM3 × 100
 * utilizationPct = cameraTonnes   / maxCapacityTonnes × 100
 */
inventoryRouter.get(
  "/inventory/reconciliation/:siteId",
  validate.params(siteIdParamsSchema),
  async (req, res, next) => {
    try {
      const { customerId }  = res.locals["auth"];
      const snapshotRepo    = res.locals["snapshotRepo"] as InventorySnapshotRepository;
      const { siteId }      = req.params as z.infer<typeof siteIdParamsSchema>;

      const rows = await snapshotRepo.findReconciliationRows(customerId, siteId);

      const piles = rows.map((r: PileReconciliationRow) => {
        const cameraVol  = r.camera_volume_m3 ? toFloat(r.camera_volume_m3) : null;
        const cameraT    = r.camera_tonnes    ? toFloat(r.camera_tonnes)    : null;
        const manualVol  = r.manual_volume_m3 ? toFloat(r.manual_volume_m3) : null;
        const maxCap     = toFloatOrNull(r.max_capacity_tonnes);

        const discrepancyM3  =
          cameraVol !== null && manualVol !== null
            ? parseFloat((cameraVol - manualVol).toFixed(4))
            : null;

        const discrepancyPct =
          discrepancyM3 !== null && manualVol !== null && manualVol !== 0
            ? parseFloat(((discrepancyM3 / manualVol) * 100).toFixed(2))
            : null;

        const utilizationPct =
          cameraT !== null && maxCap !== null && maxCap > 0
            ? parseFloat(((cameraT / maxCap) * 100).toFixed(2))
            : null;

        return {
          pileId:            r.pile_id,
          pileName:          r.pile_name,
          materialType:      r.material_type,
          maxCapacityTonnes: maxCap,
          camera: cameraVol !== null
            ? { volumeM3: cameraVol, tonnes: cameraT, measuredAt: r.camera_measured_at }
            : null,
          manual: manualVol !== null
            ? { volumeM3: manualVol, measuredAt: r.manual_measured_at }
            : null,
          discrepancyM3,
          discrepancyPct,
          utilizationPct,
        };
      });

      const totalCameraVolumeM3 = piles.reduce(
        (sum, p) => sum + (p.camera?.volumeM3 ?? 0), 0,
      );
      const hasManual = piles.some((p) => p.manual !== null);
      const totalManualVolumeM3 = hasManual
        ? piles.reduce((sum, p) => sum + (p.manual?.volumeM3 ?? 0), 0)
        : null;
      const pilesWithDiscrepancy = piles.filter(
        (p) => p.discrepancyM3 !== null && Math.abs(p.discrepancyM3) > 0,
      ).length;

      res.json({
        data: {
          siteId,
          customerId,
          generatedAt: new Date().toISOString(),
          pileCount:   piles.length,
          summary: {
            totalCameraVolumeM3:  parseFloat(totalCameraVolumeM3.toFixed(4)),
            totalManualVolumeM3:  totalManualVolumeM3 !== null
              ? parseFloat(totalManualVolumeM3.toFixed(4))
              : null,
            pilesWithDiscrepancy,
          },
          piles,
        },
      });
    } catch (err) {
      next(err);
    }
  },
);

// ── GET /inventory/history/:pileId ────────────────────────────────────────────

const historyQuerySchema = z.object({
  from:       z.coerce.date(),
  to:         z.coerce.date(),
  resolution: z.enum(["raw", "hourly", "daily"]).default("hourly"),
  limit:      z.coerce.number().int().min(1).max(5000).default(1000),
  order:      z.enum(["asc", "desc"]).default("desc"),
}).refine(
  (v) => v.from < v.to,
  { message: "'from' must be earlier than 'to'", path: ["from"] },
);

/**
 * Retrieve the volume history for a single pile.
 *
 * Query:
 *   from        ISO 8601 start (required)
 *   to          ISO 8601 end   (required)
 *   resolution  raw | hourly | daily   (default: hourly)
 *   limit       1–5000                 (default: 1000, ignored for hourly/daily)
 *   order       asc | desc             (default: desc, raw only)
 *
 * Response: 200 { data: { pileId, resolution, from, to, pointCount, points } }
 */
inventoryRouter.get(
  "/inventory/history/:pileId",
  validate.params(pileIdParamsSchema),
  validate.query(historyQuerySchema),
  async (req, res, next) => {
    try {
      const { customerId } = res.locals["auth"];
      const snapshotRepo   = res.locals["snapshotRepo"] as InventorySnapshotRepository;
      const { pileId }     = req.params as z.infer<typeof pileIdParamsSchema>;
      const query          = req.query  as unknown as z.infer<typeof historyQuerySchema>;
      const { from, to, resolution, limit, order } = query;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let points: any[];

      if (resolution === "raw") {
        const snapshots = await snapshotRepo.findRange(customerId, pileId, {
          from, to, limit, order,
        });
        points = snapshots.map((s) => ({
          time:              s.time,
          volumeM3:          s.volumeM3,
          estimatedTonnes:   s.estimatedTonnes,
          heightM:           s.heightM,
          confidenceScore:   s.confidenceScore,
          measurementSource: s.measurementSource,
        }));
      } else if (resolution === "hourly") {
        const agg = await snapshotRepo.findHourlyAggregates(customerId, pileId, { from, to });
        points = agg.map((a) => ({
          bucket:      a.bucket,
          avgVolumeM3: a.avgVolumeM3,
          minVolumeM3: a.minVolumeM3,
          maxVolumeM3: a.maxVolumeM3,
          avgTonnes:   a.avgTonnes,
          sampleCount: a.sampleCount,
        }));
      } else {
        const agg = await snapshotRepo.findDailyAggregates(customerId, pileId, { from, to });
        points = agg.map((a) => ({
          bucket:      a.bucket,
          avgVolumeM3: a.avgVolumeM3,
          minVolumeM3: a.minVolumeM3,
          maxVolumeM3: a.maxVolumeM3,
          avgTonnes:   a.avgTonnes,
          sampleCount: a.sampleCount,
        }));
      }

      res.json({
        data: {
          pileId,
          resolution,
          from:       from.toISOString(),
          to:         to.toISOString(),
          pointCount: points.length,
          points,
        },
      });
    } catch (err) {
      next(err);
    }
  },
);
