import { Pool } from "pg";
import { queryTenant, withTenantTransaction } from "../db/tenant";
import { toFloatOrNull } from "../db/parse";
import {
  SensorReading,
  SensorReadingRow,
  CreateSensorReadingInput,
} from "../types/sensorReading";

// ---------------------------------------------------------------------------
// Row mapper
// ---------------------------------------------------------------------------

function toReading(row: SensorReadingRow): SensorReading {
  return {
    time:              row.time,
    customerId:        row.customer_id,
    siteId:            row.site_id,
    sensorId:          row.sensor_id,
    sensorType:        row.sensor_type,
    temperatureC:      toFloatOrNull(row.temperature_c),
    humidityPct:       toFloatOrNull(row.humidity_pct),
    pressureHpa:       toFloatOrNull(row.pressure_hpa),
    co2Ppm:            toFloatOrNull(row.co2_ppm),
    batteryPct:        toFloatOrNull(row.battery_pct),
    signalStrengthDbm: toFloatOrNull(row.signal_strength_dbm),
    createdAt:         row.created_at,
  };
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export class SensorReadingRepository {
  constructor(private readonly pool: Pool) {}

  // ── Single insert ─────────────────────────────────────────────────────────

  /**
   * Persist one sensor reading.  Uses BEGIN/SET LOCAL/COMMIT so the RLS policy
   * on sensor_readings sees the correct tenant GUC.
   */
  async insert(
    customerId: string,
    input: CreateSensorReadingInput,
  ): Promise<SensorReading> {
    const sql = `
      INSERT INTO sensor_readings (
        time, customer_id, site_id, sensor_id, sensor_type,
        temperature_c, humidity_pct, pressure_hpa, co2_ppm,
        battery_pct, signal_strength_dbm
      ) VALUES (
        COALESCE($3, NOW()), $1, $2, $4, $5,
        $6, $7, $8, $9, $10, $11
      )
      RETURNING
        time, customer_id, site_id, sensor_id, sensor_type,
        temperature_c::text, humidity_pct::text, pressure_hpa::text, co2_ppm::text,
        battery_pct::text, signal_strength_dbm::text, created_at
    `;

    const result = await queryTenant<SensorReadingRow>(
      this.pool,
      customerId,
      sql,
      [
        customerId,
        input.siteId,
        input.time ?? null,
        input.sensorId,
        input.sensorType,
        input.temperatureC      ?? null,
        input.humidityPct       ?? null,
        input.pressureHpa       ?? null,
        input.co2Ppm            ?? null,
        input.batteryPct        ?? null,
        input.signalStrengthDbm ?? null,
      ],
    );

    const row = result.rows[0];
    if (!row) throw new Error("INSERT INTO sensor_readings returned no row");
    return toReading(row);
  }

  // ── Batch insert ─────────────────────────────────────────────────────────

  /**
   * Persist multiple readings in a single tenant-scoped transaction.
   * Up to 500 rows per call (enforced by the API layer).
   *
   * Returns the count of rows inserted.
   */
  async insertBatch(
    customerId: string,
    inputs: CreateSensorReadingInput[],
  ): Promise<number> {
    if (inputs.length === 0) return 0;

    return withTenantTransaction(this.pool, customerId, async (client) => {
      const COLS = 11; // columns per row in the VALUES list
      const placeholders = inputs
        .map((_, i) => {
          const base = i * COLS;
          return `(COALESCE($${base + 1}, NOW()), $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10}, $${base + 11})`;
        })
        .join(", ");

      const sql = `
        INSERT INTO sensor_readings (
          time, customer_id, site_id, sensor_id, sensor_type,
          temperature_c, humidity_pct, pressure_hpa, co2_ppm,
          battery_pct, signal_strength_dbm
        ) VALUES ${placeholders}
        ON CONFLICT DO NOTHING
      `;

      const params: unknown[] = [];
      for (const input of inputs) {
        params.push(
          input.time              ?? null,
          customerId,
          input.siteId,
          input.sensorId,
          input.sensorType,
          input.temperatureC      ?? null,
          input.humidityPct       ?? null,
          input.pressureHpa       ?? null,
          input.co2Ppm            ?? null,
          input.batteryPct        ?? null,
          input.signalStrengthDbm ?? null,
        );
      }

      const result = await client.query(sql, params);
      return result.rowCount ?? 0;
    });
  }

  // ── Latest per sensor at a site ───────────────────────────────────────────

  /**
   * Return the most recent reading for every sensor at a site.
   * Uses DISTINCT ON (sensor_id) for an index-only scan.
   */
  async findLatestPerSite(
    customerId: string,
    siteId: string,
  ): Promise<SensorReading[]> {
    const sql = `
      SELECT DISTINCT ON (sensor_id)
             time, customer_id, site_id, sensor_id, sensor_type,
             temperature_c::text, humidity_pct::text, pressure_hpa::text, co2_ppm::text,
             battery_pct::text, signal_strength_dbm::text, created_at
        FROM sensor_readings
       WHERE customer_id = $1
         AND site_id     = $2
       ORDER BY sensor_id, time DESC
    `;

    const result = await queryTenant<SensorReadingRow>(
      this.pool, customerId, sql, [customerId, siteId],
    );
    return result.rows.map(toReading);
  }

  // ── Time-range query ─────────────────────────────────────────────────────

  /**
   * Fetch raw readings for a specific sensor within a time window.
   */
  async findRange(
    customerId: string,
    sensorId: string,
    from: Date,
    to: Date,
    limit = 1000,
  ): Promise<SensorReading[]> {
    const sql = `
      SELECT time, customer_id, site_id, sensor_id, sensor_type,
             temperature_c::text, humidity_pct::text, pressure_hpa::text, co2_ppm::text,
             battery_pct::text, signal_strength_dbm::text, created_at
        FROM sensor_readings
       WHERE customer_id = $1
         AND sensor_id   = $2
         AND time       >= $3
         AND time        < $4
       ORDER BY time DESC
       LIMIT $5
    `;

    const result = await queryTenant<SensorReadingRow>(
      this.pool, customerId, sql, [customerId, sensorId, from, to, limit],
    );
    return result.rows.map(toReading);
  }
}
