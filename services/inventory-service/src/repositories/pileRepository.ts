import { Pool } from "pg";
import { queryTenant, withTenantTransaction } from "../db/tenant";
import { NotFoundError, UniqueConstraintError } from "../db/errors";
import { toFloatOrNull } from "../db/parse";
import {
  Pile,
  PileRow,
  CreatePileInput,
  UpdatePileInput,
  FindPilesOptions,
} from "../types/pile";

// ---------------------------------------------------------------------------
// Row mapper
// ---------------------------------------------------------------------------

function toPile(row: PileRow): Pile {
  return {
    id:                row.id,
    customerId:        row.customer_id,
    siteId:            row.site_id,
    name:              row.name,
    materialType:      row.material_type,
    footprint:         row.footprint,
    maxCapacityTonnes: toFloatOrNull(row.max_capacity_tonnes),
    bulkDensityT_m3:   toFloatOrNull(row.bulk_density_t_m3),
    isActive:          row.is_active,
    createdAt:         row.created_at,
    updatedAt:         row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// PileRepository
// ---------------------------------------------------------------------------

export class PileRepository {
  constructor(private readonly pool: Pool) {}

  // ── Queries ────────────────────────────────────────────────────────────────

  /**
   * Fetch a single pile by ID.
   * Returns null when the pile does not exist or does not belong to the tenant.
   */
  async findById(
    customerId: string,
    pileId: string,
    options: FindPilesOptions = {},
  ): Promise<Pile | null> {
    const { activeOnly = true } = options;

    const sql = `
      SELECT id, customer_id, site_id, name, material_type, footprint,
             max_capacity_tonnes, bulk_density_t_m3, is_active, created_at, updated_at
      FROM   piles
      WHERE  customer_id = $1
        AND  id          = $2
        ${activeOnly ? "AND is_active = TRUE" : ""}
    `;

    const result = await queryTenant<PileRow>(this.pool, customerId, sql, [
      customerId,
      pileId,
    ]);

    return result.rows[0] ? toPile(result.rows[0]) : null;
  }

  /**
   * Fetch all piles at a site, ordered by name.
   */
  async findBySite(
    customerId: string,
    siteId: string,
    options: FindPilesOptions = {},
  ): Promise<Pile[]> {
    const { activeOnly = true } = options;

    const sql = `
      SELECT id, customer_id, site_id, name, material_type, footprint,
             max_capacity_tonnes, bulk_density_t_m3, is_active, created_at, updated_at
      FROM   piles
      WHERE  customer_id = $1
        AND  site_id     = $2
        ${activeOnly ? "AND is_active = TRUE" : ""}
      ORDER  BY name
    `;

    const result = await queryTenant<PileRow>(this.pool, customerId, sql, [
      customerId,
      siteId,
    ]);

    return result.rows.map(toPile);
  }

  /**
   * Fetch all piles for a tenant across all sites.
   */
  async findAll(
    customerId: string,
    options: FindPilesOptions = {},
  ): Promise<Pile[]> {
    const { activeOnly = true } = options;

    const sql = `
      SELECT id, customer_id, site_id, name, material_type, footprint,
             max_capacity_tonnes, bulk_density_t_m3, is_active, created_at, updated_at
      FROM   piles
      WHERE  customer_id = $1
        ${activeOnly ? "AND is_active = TRUE" : ""}
      ORDER  BY site_id, name
    `;

    const result = await queryTenant<PileRow>(this.pool, customerId, sql, [
      customerId,
    ]);

    return result.rows.map(toPile);
  }

  // ── Mutations ─────────────────────────────────────────────────────────────

  /**
   * Create a new pile.
   * Throws UniqueConstraintError when (customer_id, site_id, name) already exists.
   */
  async create(customerId: string, input: CreatePileInput): Promise<Pile> {
    const sql = `
      INSERT INTO piles
        (customer_id, site_id, name, material_type,
         max_capacity_tonnes, bulk_density_t_m3)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id, customer_id, site_id, name, material_type, footprint,
                max_capacity_tonnes, bulk_density_t_m3, is_active, created_at, updated_at
    `;

    const result = await queryTenant<PileRow>(this.pool, customerId, sql, [
      customerId,
      input.siteId,
      input.name,
      input.materialType,
      input.maxCapacityTonnes ?? null,
      input.bulkDensityT_m3  ?? null,
    ]);

    // RETURNING always yields exactly one row on success
    const row = result.rows[0];
    if (!row) throw new Error("INSERT returned no rows");
    return toPile(row);
  }

  /**
   * Partially update a pile.
   * Only the fields present in `input` are modified.
   * Returns the updated pile, or null when the pile does not exist.
   * Throws UniqueConstraintError on name collision.
   */
  async update(
    customerId: string,
    pileId: string,
    input: UpdatePileInput,
  ): Promise<Pile | null> {
    // Build a dynamic SET clause for only the provided fields.
    const setClauses: string[] = [];
    const params: unknown[]   = [customerId, pileId];

    const append = (col: string, value: unknown): void => {
      params.push(value);
      setClauses.push(`${col} = $${params.length}`);
    };

    if (input.name              !== undefined) append("name",                input.name);
    if (input.materialType      !== undefined) append("material_type",       input.materialType);
    if (input.maxCapacityTonnes !== undefined) append("max_capacity_tonnes", input.maxCapacityTonnes);
    if (input.bulkDensityT_m3   !== undefined) append("bulk_density_t_m3",   input.bulkDensityT_m3);
    if (input.isActive          !== undefined) append("is_active",           input.isActive);

    // updatePileSchema.refine() guarantees at least one field is present,
    // but guard defensively so the caller can also use the repository directly.
    if (setClauses.length === 0) {
      return this.findById(customerId, pileId);
    }

    const sql = `
      UPDATE piles
         SET ${setClauses.join(", ")}
       WHERE customer_id = $1
         AND id          = $2
      RETURNING id, customer_id, site_id, name, material_type, footprint,
                max_capacity_tonnes, bulk_density_t_m3, is_active, created_at, updated_at
    `;

    const result = await queryTenant<PileRow>(this.pool, customerId, sql, params);
    return result.rows[0] ? toPile(result.rows[0]) : null;
  }

  /**
   * Soft-delete a pile by setting is_active = FALSE.
   * Throws NotFoundError when the pile does not exist.
   */
  async deactivate(customerId: string, pileId: string): Promise<Pile> {
    const sql = `
      UPDATE piles
         SET is_active = FALSE
       WHERE customer_id = $1
         AND id          = $2
      RETURNING id, customer_id, site_id, name, material_type, footprint,
                max_capacity_tonnes, bulk_density_t_m3, is_active, created_at, updated_at
    `;

    const result = await queryTenant<PileRow>(this.pool, customerId, sql, [
      customerId,
      pileId,
    ]);

    if (!result.rows[0]) {
      throw new NotFoundError("Pile", pileId);
    }
    return toPile(result.rows[0]);
  }

  /**
   * Permanently delete a pile and all its time-series data (CASCADE).
   * Use with caution — prefer deactivate() in production.
   * Returns true when a row was deleted.
   */
  async hardDelete(customerId: string, pileId: string): Promise<boolean> {
    const sql = `
      DELETE FROM piles
       WHERE customer_id = $1
         AND id          = $2
    `;

    const result = await queryTenant(this.pool, customerId, sql, [
      customerId,
      pileId,
    ]);

    return (result.rowCount ?? 0) > 0;
  }

  // ── Guard ─────────────────────────────────────────────────────────────────

  /**
   * Assert a pile exists and belongs to the tenant, throwing NotFoundError if not.
   * Lightweight check used by other services before writing time-series data.
   */
  async assertExists(customerId: string, pileId: string): Promise<void> {
    const sql = `
      SELECT 1 FROM piles
       WHERE customer_id = $1
         AND id          = $2
         AND is_active   = TRUE
    `;

    const result = await queryTenant(this.pool, customerId, sql, [
      customerId,
      pileId,
    ]);

    if ((result.rowCount ?? 0) === 0) {
      throw new NotFoundError("Pile", pileId);
    }
  }
}
