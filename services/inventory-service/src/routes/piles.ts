import { Router } from "express";
import { z } from "zod";
import { authenticate } from "../middleware/authenticate";
import { validate } from "../middleware/validate";
import { AppError } from "../middleware/errorHandler";
import { createPileSchema, updatePileSchema } from "../types/pile";
import { MEASUREMENT_SOURCES } from "../types/inventorySnapshot";
import { PileRepository } from "../repositories/pileRepository";
import { InventorySnapshotRepository } from "../repositories/inventorySnapshotRepository";
import { UniqueConstraintError, NotFoundError } from "../db/errors";

export const pilesRouter = Router();

// All pile routes require a valid JWT.
pilesRouter.use(authenticate);

// ── Param schemas ─────────────────────────────────────────────────────────────

const pileIdParamsSchema  = z.object({ id:     z.string().uuid("id must be a UUID") });
const siteIdParamsSchema  = z.object({ siteId: z.string().uuid("siteId must be a UUID") });

const listSitePilesQuerySchema = z.object({
  activeOnly: z.enum(["true", "false"]).default("true"),
});

// Body schema for PUT /piles/:id/volume — a focused subset of CreateSnapshotInput.
// customerId / siteId / pileId come from the JWT + URL params; the caller
// should not be able to forge them through the body.
const updateVolumeBodySchema = z.object({
  volumeM3:          z.number().nonnegative(),
  estimatedTonnes:   z.number().nonnegative().nullable().optional(),
  heightM:           z.number().nonnegative().nullable().optional(),
  surfaceAreaM2:     z.number().nonnegative().nullable().optional(),
  confidenceScore:   z.number().min(0).max(1).nullable().optional(),
  measurementSource: z.enum(MEASUREMENT_SOURCES).default("camera"),
  cameraId:          z.string().uuid().nullable().optional(),
  time:              z.coerce.date().optional(),
  rawImagePath:      z.string().max(1024).nullable().optional(),
});

// ── POST /piles ───────────────────────────────────────────────────────────────

/**
 * Create a new pile for the authenticated tenant.
 *
 * Body: { siteId, name, materialType, maxCapacityTonnes?, bulkDensityT_m3? }
 * Response: 201 { data: Pile }
 */
pilesRouter.post(
  "/piles",
  validate.body(createPileSchema),
  async (req, res, next) => {
    try {
      const { customerId } = res.locals["auth"];
      const pileRepo = res.locals["pileRepo"] as PileRepository;

      const pile = await pileRepo.create(customerId, req.body);
      res.status(201).json({ data: pile });
    } catch (err) {
      if (err instanceof UniqueConstraintError) {
        next(new AppError(409, "A pile with that name already exists at this site", "PILE_EXISTS"));
      } else {
        next(err);
      }
    }
  },
);

// ── GET /piles/:siteId ────────────────────────────────────────────────────────

/**
 * List all piles at a site for the authenticated tenant.
 *
 * Query: { activeOnly?: "true" | "false" }   default: "true"
 * Response: 200 { data: Pile[], count: number }
 */
pilesRouter.get(
  "/piles/:siteId",
  validate.params(siteIdParamsSchema),
  validate.query(listSitePilesQuerySchema),
  async (req, res, next) => {
    try {
      const { customerId } = res.locals["auth"];
      const pileRepo = res.locals["pileRepo"] as PileRepository;
      const { siteId }     = req.params as z.infer<typeof siteIdParamsSchema>;
      const { activeOnly } = req.query  as z.infer<typeof listSitePilesQuerySchema>;

      const piles = await pileRepo.findBySite(customerId, siteId, {
        activeOnly: activeOnly !== "false",
      });

      res.json({ data: piles, count: piles.length });
    } catch (err) {
      next(err);
    }
  },
);

// ── PUT /piles/:id/volume ─────────────────────────────────────────────────────

/**
 * Record a new volume measurement for a pile.
 * Looks up the pile first to verify ownership and obtain siteId,
 * then inserts a row into inventory_snapshots.
 *
 * Body:  { volumeM3, measurementSource?, time?, ... }
 * Response: 201 { data: InventorySnapshot }
 */
pilesRouter.put(
  "/piles/:id/volume",
  validate.params(pileIdParamsSchema),
  validate.body(updateVolumeBodySchema),
  async (req, res, next) => {
    try {
      const { customerId }  = res.locals["auth"];
      const pileRepo        = res.locals["pileRepo"]     as PileRepository;
      const snapshotRepo    = res.locals["snapshotRepo"] as InventorySnapshotRepository;
      const { id: pileId }  = req.params as z.infer<typeof pileIdParamsSchema>;

      // Verify ownership and retrieve siteId in one round-trip.
      const pile = await pileRepo.findById(customerId, pileId);
      if (!pile) {
        throw new AppError(404, `Pile ${pileId} not found`, "PILE_NOT_FOUND");
      }

      const body = req.body as z.infer<typeof updateVolumeBodySchema>;

      const snapshot = await snapshotRepo.insert({
        customerId,
        siteId:            pile.siteId,
        pileId,
        cameraId:          body.cameraId          ?? null,
        volumeM3:          body.volumeM3,
        estimatedTonnes:   body.estimatedTonnes   ?? null,
        heightM:           body.heightM           ?? null,
        surfaceAreaM2:     body.surfaceAreaM2      ?? null,
        confidenceScore:   body.confidenceScore   ?? null,
        measurementSource: body.measurementSource,
        time:              body.time,
        rawImagePath:      body.rawImagePath       ?? null,
      });

      res.status(201).json({ data: snapshot });
    } catch (err) {
      if (err instanceof NotFoundError) {
        next(new AppError(404, err.message, "PILE_NOT_FOUND"));
      } else {
        next(err);
      }
    }
  },
);
