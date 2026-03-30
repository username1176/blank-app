"""
MoistureRepository — persistence layer for moisture_readings.

Writes predictions to the TimescaleDB hypertable that was created by the
V3 migration.  All writes use the tenant GUC pattern (SET LOCAL
app.current_customer_id) so row-level security policies are satisfied.

Table columns used
------------------
time                  TIMESTAMPTZ  NOT NULL
customer_id           UUID         NOT NULL
site_id               UUID         NOT NULL
pile_id               UUID         NOT NULL
camera_id             UUID
moisture_pct          NUMERIC(6,3) NOT NULL  0–100
confidence_score      NUMERIC(4,3)           0–1
zone_classification   TEXT         NOT NULL  dry|normal|wet
model_version         TEXT
thermal_image_path    TEXT
ambient_temp_c        NUMERIC(6,2)
ambient_humidity_pct  NUMERIC(6,3)
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Literal

import asyncpg

ZoneClassification = Literal["dry", "normal", "wet"]

# ---------------------------------------------------------------------------
# Domain types
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class MoistureReadingInsert:
    customer_id:          str
    site_id:              str
    pile_id:              str
    moisture_pct:         float
    zone_classification:  ZoneClassification
    camera_id:            str | None        = None
    confidence_score:     float | None      = None
    model_version:        str | None        = None
    thermal_image_path:   str | None        = None
    ambient_temp_c:       float | None      = None
    ambient_humidity_pct: float | None      = None
    time:                 datetime | None   = None   # defaults to NOW()


@dataclass(frozen=True)
class MoistureReading:
    """Row echoed back to the caller after a successful insert."""
    reading_time:         datetime
    customer_id:          str
    site_id:              str
    pile_id:              str
    camera_id:            str | None
    moisture_pct:         float
    confidence_score:     float | None
    zone_classification:  ZoneClassification
    model_version:        str | None
    thermal_image_path:   str | None
    ambient_temp_c:       float | None
    ambient_humidity_pct: float | None
    created_at:           datetime


# ---------------------------------------------------------------------------
# Repository
# ---------------------------------------------------------------------------

class MoistureRepository:
    """
    Thin async wrapper around asyncpg for moisture_readings writes.

    Parameters
    ----------
    conn : asyncpg.Connection
        A checked-out connection from the pool (injected via Depends(get_db)).
    """

    def __init__(self, conn: asyncpg.Connection) -> None:
        self._conn = conn

    async def insert(self, reading: MoistureReadingInsert) -> MoistureReading:
        """
        Persist one prediction row inside a tenant-scoped transaction.

        The GUC ``app.current_customer_id`` is set within a BEGIN/SET LOCAL/COMMIT
        block so the RLS policy on moisture_readings is satisfied and the value
        cannot leak to other pool connections.
        """
        ts = reading.time or datetime.now(tz=timezone.utc)

        sql = """
            INSERT INTO moisture_readings (
                time,
                customer_id,
                site_id,
                pile_id,
                camera_id,
                moisture_pct,
                confidence_score,
                zone_classification,
                model_version,
                thermal_image_path,
                ambient_temp_c,
                ambient_humidity_pct
            ) VALUES (
                $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12
            )
            RETURNING
                time              AS reading_time,
                customer_id,
                site_id,
                pile_id,
                camera_id,
                moisture_pct::float,
                confidence_score::float,
                zone_classification,
                model_version,
                thermal_image_path,
                ambient_temp_c::float,
                ambient_humidity_pct::float,
                created_at
        """

        async with self._conn.transaction():
            await self._conn.execute(
                "SET LOCAL app.current_customer_id = $1",
                reading.customer_id,
            )
            row = await self._conn.fetchrow(
                sql,
                ts,
                reading.customer_id,
                reading.site_id,
                reading.pile_id,
                reading.camera_id,
                reading.moisture_pct,
                reading.confidence_score,
                reading.zone_classification,
                reading.model_version,
                reading.thermal_image_path,
                reading.ambient_temp_c,
                reading.ambient_humidity_pct,
            )

        if row is None:
            raise RuntimeError("INSERT INTO moisture_readings returned no row")

        return MoistureReading(
            reading_time=row["reading_time"],
            customer_id=row["customer_id"],
            site_id=row["site_id"],
            pile_id=row["pile_id"],
            camera_id=row["camera_id"],
            moisture_pct=float(row["moisture_pct"]),
            confidence_score=float(row["confidence_score"]) if row["confidence_score"] is not None else None,
            zone_classification=row["zone_classification"],
            model_version=row["model_version"],
            thermal_image_path=row["thermal_image_path"],
            ambient_temp_c=float(row["ambient_temp_c"]) if row["ambient_temp_c"] is not None else None,
            ambient_humidity_pct=float(row["ambient_humidity_pct"]) if row["ambient_humidity_pct"] is not None else None,
            created_at=row["created_at"],
        )
