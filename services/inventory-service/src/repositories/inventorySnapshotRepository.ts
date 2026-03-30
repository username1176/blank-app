import { Pool } from "pg";
import { queryTenant, withTenantTransaction } from "../db/tenant";
import { NotFoundError } from "../db/errors";
import { buildValuesList, toFloat, toFloatOrNull, toInt } from "../db/parse";
import {
  InventorySnapshot,
  SnapshotRow,
  HourlyAggregateRow,
  DailyAggregateRow,
  HourlyAggregate,
  DailyAggregate,
  DropDetection,
  CreateSnapshotInput,
  TimeRangeOptions,
  PileReconciliationRow,
} from "../types/inventorySnapshot";

// ---------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------

function toSnapshot(row: SnapshotRow): InventorySnapshot {
  return {
    time:              row.time,
    customerId:        row.customer_id,
    siteId:            row.site_id,
    pileId:            row.pile_id,
    cameraId:          row.camera_id,
    volumeM3:          toFloat(row.volume_m3),
    estimatedTonnes:   toFloatOrNull(row.estimated_tonnes),
    heightM:           toFloatOrNull(row.height_m),
    surfaceAreaM2:     toFloatOrNull(row.surface_area_m2),
    confidenceScore:   toFloatOrNull(row.confidence_score),
    measurementSource: row.measurement_source,
    rawImagePath:      row.raw_image_path,
    createdAt:         row.created_at,
  };
}

function toHourly(row: HourlyAggregateRow): HourlyAggregate {
  return {
    bucket:      row.bucket,
    customerId:  row.customer_id,
    siteId:      row.site_id,
    pileId:      row.pile_id,
    avgVolumeM3: toFloat(row.avg_volume_m3),
    minVolumeM3: toFloat(row.min_volume_m3),
    maxVolumeM3: toFloat(row.max_volume_m3),
    avgTonnes:   toFloatOrNull(row.avg_tonnes),
    minTonnes:   toFloatOrNull(row.min_tonnes),
    maxTonnes:   toFloatOrNull(row.max_tonnes),
    sampleCount: toInt(row.sample_count),
  };
}

function toDaily(row: DailyAggregateRow): DailyAggregate {
  return {
    bucket:      row.bucket,
    customerId:  row.customer_id,
    siteId:      row.site_id,
    pileId:      row.pile_id,
    avgVolumeM3: toFloat(row.avg_volume_m3),
    minVolumeM3: toFloat(row.min_volume_m3),
    maxVolumeM3: toFloat(row.max_volume_m3),
    avgTonnes:   toFloatOrNull(row.avg_tonnes),
    minTonnes:   toFloatOrNull(row.min_tonnes),
    maxTonnes:   toFloatOrNull(row.max_tonnes),
    sampleCount: toInt(row.sample_count),
  };
}

// ---------------------------------------------------------------------------
// InventorySnapshotRepository
// ---------------------------------------------------------------------------

const DEFAULT_RANGE_LIMIT = 1000;
const MAX_BATCH_SIZE      = 500;

export class InventorySnapshotRepository {
  constructor(private readonly pool: Pool) {}

  // ── Writes ────────────────────────────────────────────────────────────────

  /**
   * Insert a single snapshot.
   * The `time` field defaults to NOW() when omitted.
   */
  async insert(input: CreateSnapshotInput): Promise<InventorySnapshot> {
    const sql = `
      INSERT INTO inventory_snapshots
        (time, customer_id, site_id, pile_id, camera_id,
         volume_m3, estimated_tonnes, height_m, surface_area_m2,
         confidence_score, measurement_source, raw_image_path)
      VALUES
        (COALESCE($3, NOW()), $1, $4, $5, $6,
         $7, $8, $9, $10,
         $11, $12, $13)
      RETURNING
        time, customer_id, site_id, pile_id, camera_id,
        volume_m3, estimated_tonnes, height_m, surface_area_m2,
        confidence_score, measurement_source, raw_image_path, created_at
    `;

    const result = await queryTenant<SnapshotRow>(
      this.pool,
      input.customerId,
      sql,
      [
        input.customerId,
        input.customerId,       // $2 unused — placeholder kept for param alignment
        input.time ?? null,
        input.siteId,
        input.pileId,
        input.cameraId          ?? null,
        input.volumeM3,
        input.estimatedTonnes   ?? null,
        input.heightM           ?? null,
        input.surfaceAreaM2     ?? null,
        input.confidenceScore   ?? null,
        input.measurementSource,
        input.rawImagePath      ?? null,
      ],
    );

    const row = result.rows[0];
    if (!row) throw new Error("INSERT returned no rows");
    return toSnapshot(row);
  }

  /**
   * Insert multiple snapshots in a single statement.
   * All snapshots must belong to the same tenant.
   * Throws when `snapshots` is empty or exceeds MAX_BATCH_SIZE.
   * Returns the number of rows inserted.
   */
  async insertBatch(
    customerId: string,
    snapshots: CreateSnapshotInput[],
  ): Promise<number> {
    if (snapshots.length === 0) return 0;
    if (snapshots.length > MAX_BATCH_SIZE) {
      throw new Error(
        `insertBatch exceeds maximum batch size of ${MAX_BATCH_SIZE}`,
      );
    }

    const COLS = 13;
    const rows = snapshots.map((s) => [
      s.time ?? new Date(),
      customerId,
      s.siteId,
      s.pileId,
      s.cameraId          ?? null,
      s.volumeM3,
      s.estimatedTonnes   ?? null,
      s.heightM           ?? null,
      s.surfaceAreaM2     ?? null,
      s.confidenceScore   ?? null,
      s.measurementSource,
      s.rawImagePath      ?? null,
      customerId,           // tenant safety — see WHERE in upsert paths
    ]);

    const { text: valuesList, values } = buildValuesList(rows, COLS);

    const sql = `
      INSERT INTO inventory_snapshots
        (time, customer_id, site_id, pile_id, camera_id,
         volume_m3, estimated_tonnes, height_m, surface_area_m2,
         confidence_score, measurement_source, raw_image_path,
         customer_id)
      VALUES ${valuesList}
    `;

    // Re-write to avoid the duplicate customer_id column — use a clean list
    const cleanRows = snapshots.map((s) => [
      s.time ?? new Date(),
      customerId,
      s.siteId,
      s.pileId,
      s.cameraId          ?? null,
      s.volumeM3,
      s.estimatedTonnes   ?? null,
      s.heightM           ?? null,
      s.surfaceAreaM2     ?? null,
      s.confidenceScore   ?? null,
      s.measurementSource,
      s.rawImagePath      ?? null,
    ]);

    const CLEAN_COLS = 12;
    const { text: vl, values: cleanValues } = buildValuesList(cleanRows, CLEAN_COLS);

    const cleanSql = `
      INSERT INTO inventory_snapshots
        (time, customer_id, site_id, pile_id, camera_id,
         volume_m3, estimated_tonnes, height_m, surface_area_m2,
         confidence_score, measurement_source, raw_image_path)
      VALUES ${vl}
    `;

    const result = await withTenantTransaction(
      this.pool,
      customerId,
      (client) => client.query(cleanSql, cleanValues),
    );

    return result.rowCount ?? 0;
  }

  // ── Point-in-time queries ─────────────────────────────────────────────────

  /**
   * Return the most recent snapshot for a pile.
   * Uses the idx_inv_snap_pile_latest index (pile_id, time DESC).
   */
  async findLatest(
    customerId: string,
    pileId: string,
  ): Promise<InventorySnapshot | null> {
    const sql = `
      SELECT time, customer_id, site_id, pile_id, camera_id,
             volume_m3, estimated_tonnes, height_m, surface_area_m2,
             confidence_score, measurement_source, raw_image_path, created_at
        FROM inventory_snapshots
       WHERE customer_id = $1
         AND pile_id     = $2
       ORDER BY time DESC
       LIMIT 1
    `;

    const result = await queryTenant<SnapshotRow>(this.pool, customerId, sql, [
      customerId,
      pileId,
    ]);

    return result.rows[0] ? toSnapshot(result.rows[0]) : null;
  }

  /**
   * Return the most recent snapshot for every pile at a site using
   * DISTINCT ON — O(N piles) rather than N separate queries.
   * Uses idx_inv_snap_customer_site_time.
   */
  async findLatestPerSite(
    customerId: string,
    siteId: string,
  ): Promise<InventorySnapshot[]> {
    const sql = `
      SELECT DISTINCT ON (pile_id)
             time, customer_id, site_id, pile_id, camera_id,
             volume_m3, estimated_tonnes, height_m, surface_area_m2,
             confidence_score, measurement_source, raw_image_path, created_at
        FROM inventory_snapshots
       WHERE customer_id = $1
         AND site_id     = $2
       ORDER BY pile_id, time DESC
    `;

    const result = await queryTenant<SnapshotRow>(this.pool, customerId, sql, [
      customerId,
      siteId,
    ]);

    return result.rows.map(toSnapshot);
  }

  // ── Time-range queries ────────────────────────────────────────────────────

  /**
   * Return raw snapshots for a pile within a time window.
   * Defaults to DESC order and a 1 000-row limit.
   */
  async findRange(
    customerId: string,
    pileId: string,
    options: TimeRangeOptions,
  ): Promise<InventorySnapshot[]> {
    const {
      from,
      to,
      limit = DEFAULT_RANGE_LIMIT,
      order = "desc",
    } = options;

    const direction = order === "asc" ? "ASC" : "DESC";

    const sql = `
      SELECT time, customer_id, site_id, pile_id, camera_id,
             volume_m3, estimated_tonnes, height_m, surface_area_m2,
             confidence_score, measurement_source, raw_image_path, created_at
        FROM inventory_snapshots
       WHERE customer_id = $1
         AND pile_id     = $2
         AND time >= $3
         AND time <  $4
       ORDER BY time ${direction}
       LIMIT $5
    `;

    const result = await queryTenant<SnapshotRow>(this.pool, customerId, sql, [
      customerId,
      pileId,
      from,
      to,
      limit,
    ]);

    return result.rows.map(toSnapshot);
  }

  // ── Continuous aggregate queries ──────────────────────────────────────────

  /**
   * Return pre-aggregated hourly buckets from the inventory_hourly
   * continuous aggregate view.  Avoids scanning raw hypertable chunks
   * for time ranges longer than a few hours.
   */
  async findHourlyAggregates(
    customerId: string,
    pileId: string,
    options: Omit<TimeRangeOptions, "limit" | "order">,
  ): Promise<HourlyAggregate[]> {
    const { from, to } = options;

    const sql = `
      SELECT bucket, customer_id, site_id, pile_id,
             avg_volume_m3, min_volume_m3, max_volume_m3,
             avg_tonnes, min_tonnes, max_tonnes, sample_count
        FROM inventory_hourly
       WHERE customer_id = $1
         AND pile_id     = $2
         AND bucket >= $3
         AND bucket <  $4
       ORDER BY bucket DESC
    `;

    const result = await queryTenant<HourlyAggregateRow>(
      this.pool,
      customerId,
      sql,
      [customerId, pileId, from, to],
    );

    return result.rows.map(toHourly);
  }

  /**
   * Return pre-aggregated daily buckets from the inventory_daily
   * continuous aggregate view.  Use for 30/90/365-day trend charts.
   */
  async findDailyAggregates(
    customerId: string,
    pileId: string,
    options: Omit<TimeRangeOptions, "limit" | "order">,
  ): Promise<DailyAggregate[]> {
    const { from, to } = options;

    const sql = `
      SELECT bucket, customer_id, site_id, pile_id,
             avg_volume_m3, min_volume_m3, max_volume_m3,
             avg_tonnes, min_tonnes, max_tonnes, sample_count
        FROM inventory_daily
       WHERE customer_id = $1
         AND pile_id     = $2
         AND bucket >= $3
         AND bucket <  $4
       ORDER BY bucket DESC
    `;

    const result = await queryTenant<DailyAggregateRow>(
      this.pool,
      customerId,
      sql,
      [customerId, pileId, from, to],
    );

    return result.rows.map(toDaily);
  }

  // ── Anomaly detection ─────────────────────────────────────────────────────

  /**
   * Detect a sudden volume drop on a pile.
   *
   * Compares the latest snapshot volume against the average of the preceding
   * `lookbackMinutes` window (default 60 min).  Returns a DropDetection when
   * the percentage drop meets or exceeds `thresholdPct`, otherwise null.
   *
   * This is the same logic used by the Kafka alert publisher.
   */
  async detectSuddenDrop(
    customerId: string,
    pileId: string,
    thresholdPct: number = 15,
    lookbackMinutes: number = 60,
  ): Promise<DropDetection | null> {
    const sql = `
      WITH latest AS (
        SELECT volume_m3, time
          FROM inventory_snapshots
         WHERE customer_id = $1
           AND pile_id     = $2
         ORDER BY time DESC
         LIMIT 1
      ),
      reference AS (
        SELECT AVG(volume_m3) AS avg_vol
          FROM inventory_snapshots
         WHERE customer_id = $1
           AND pile_id     = $2
           AND time >= NOW() - ($3 || ' minutes')::INTERVAL
           AND time <  (SELECT time FROM latest)
      )
      SELECT
        latest.volume_m3                                          AS current_volume,
        reference.avg_vol                                         AS reference_volume,
        ROUND(
          ((reference.avg_vol - latest.volume_m3)
           / NULLIF(reference.avg_vol, 0) * 100)::NUMERIC, 2
        )                                                         AS drop_pct,
        latest.time                                               AS detected_at
      FROM latest, reference
      WHERE reference.avg_vol IS NOT NULL
        AND latest.volume_m3  IS NOT NULL
        AND ((reference.avg_vol - latest.volume_m3)
             / NULLIF(reference.avg_vol, 0) * 100) >= $4
    `;

    interface DropRow {
      current_volume:    string;
      reference_volume:  string;
      drop_pct:          string;
      detected_at:       Date;
    }

    const result = await queryTenant<DropRow>(this.pool, customerId, sql, [
      customerId,
      pileId,
      lookbackMinutes,
      thresholdPct,
    ]);

    const row = result.rows[0];
    if (!row) return null;

    return {
      pileId,
      currentVolumeM3:   toFloat(row.current_volume),
      referenceVolumeM3: toFloat(row.reference_volume),
      dropPct:           toFloat(row.drop_pct),
      detectedAt:        row.detected_at,
    };
  }

  // ── Reconciliation ────────────────────────────────────────────────────────

  /**
   * Return the latest camera and manual measurements for every active pile at
   * a site in a single query using DISTINCT ON.  The caller computes the
   * discrepancy values in JS (business logic belongs outside the DAL).
   */
  async findReconciliationRows(
    customerId: string,
    siteId: string,
  ): Promise<PileReconciliationRow[]> {
    const sql = `
      WITH pile_camera AS (
        SELECT DISTINCT ON (pile_id)
               pile_id,
               volume_m3        AS camera_volume_m3,
               estimated_tonnes AS camera_tonnes,
               time             AS camera_measured_at
          FROM inventory_snapshots
         WHERE customer_id       = $1
           AND site_id           = $2
           AND measurement_source = 'camera'
         ORDER BY pile_id, time DESC
      ),
      pile_manual AS (
        SELECT DISTINCT ON (pile_id)
               pile_id,
               volume_m3 AS manual_volume_m3,
               time      AS manual_measured_at
          FROM inventory_snapshots
         WHERE customer_id       = $1
           AND site_id           = $2
           AND measurement_source = 'manual'
         ORDER BY pile_id, time DESC
      )
      SELECT
        p.id                  AS pile_id,
        p.name                AS pile_name,
        p.material_type,
        p.max_capacity_tonnes,
        p.bulk_density_t_m3,
        pc.camera_volume_m3,
        pc.camera_tonnes,
        pc.camera_measured_at,
        pm.manual_volume_m3,
        pm.manual_measured_at
      FROM   piles p
      LEFT   JOIN pile_camera pc ON pc.pile_id = p.id
      LEFT   JOIN pile_manual  pm ON pm.pile_id = p.id
      WHERE  p.customer_id = $1
        AND  p.site_id     = $2
        AND  p.is_active   = TRUE
      ORDER  BY p.name
    `;

    const result = await queryTenant<PileReconciliationRow>(
      this.pool,
      customerId,
      sql,
      [customerId, siteId],
    );
    return result.rows;
  }
}
