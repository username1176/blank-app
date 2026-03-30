"""
Uploader — converts PipelineResult into API payloads and posts them.

Offline resilience
------------------
When a `BufferStore` is injected, every failed upload is automatically
persisted to the local SQLite buffer rather than being silently dropped.
Buffered entries are replayed by `BufferSyncer` during subsequent cycles
once connectivity is restored.

Success semantics:
  The `upload()` method always returns cleanly — "success" means either
  the data was accepted by the remote API *or* it was safely persisted
  to the local buffer.  A True/False flag in `UploadResult` indicates
  which path was taken.

API contracts:
  moisture-service  POST /predict     multipart/form-data
      image           (file)  pseudocolour JPEG
      pile_id         str     UUID
      site_id         str     UUID
      camera_id       str     UUID, optional
      sensor_readings str     JSON array, optional

  inventory-service  PUT /piles/:pileId/volume   application/json
      volumeM3, estimatedTonnes, heightM, surfaceAreaM2,
      confidenceScore, measurementSource, cameraId, time, rawImagePath
"""

from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Optional

from ..config.settings import Settings
from ..processing.pipeline import PipelineResult
from .client import ApiClient

if TYPE_CHECKING:
    from ..buffer.store import BufferStore

logger = logging.getLogger(__name__)

# HTTP status codes that indicate a transient server fault worth buffering
_BUFFER_ON_STATUS = {500, 502, 503, 504}


@dataclass
class UploadResult:
    """Outcome of a single upload cycle."""
    # HTTP status from the live upload (None if not attempted / buffered)
    moisture_status:  Optional[int] = None
    moisture_error:   Optional[str] = None
    moisture_buffered: bool = False

    inventory_status:  Optional[int] = None
    inventory_error:   Optional[str] = None
    inventory_buffered: bool = False

    @property
    def fully_live(self) -> bool:
        """True when both targets were accepted live (no buffering needed)."""
        return (
            (self.moisture_status is None or 200 <= self.moisture_status < 300)
            and not self.moisture_buffered
            and (self.inventory_status is None or 200 <= self.inventory_status < 300)
            and not self.inventory_buffered
        )

    @property
    def any_buffered(self) -> bool:
        return self.moisture_buffered or self.inventory_buffered

    def __repr__(self) -> str:
        return (
            f"UploadResult("
            f"moisture={self.moisture_status}{'(buf)' if self.moisture_buffered else ''}, "
            f"inventory={self.inventory_status}{'(buf)' if self.inventory_buffered else ''})"
        )


class Uploader:
    """
    Posts `PipelineResult` data to the relevant backend services.

    When a `BufferStore` is provided, network failures and 5xx responses
    cause the payload to be buffered locally for later replay.

    Parameters
    ----------
    settings
        Application settings.
    moisture_client
        `ApiClient` pointed at moisture-service.
    inventory_client
        `ApiClient` pointed at inventory-service.
    buffer
        Optional offline buffer.  Pass None to disable buffering.
    """

    def __init__(
        self,
        settings: Settings,
        moisture_client: ApiClient,
        inventory_client: ApiClient,
        buffer: Optional["BufferStore"] = None,
    ) -> None:
        self._s = settings
        self._moisture  = moisture_client
        self._inventory = inventory_client
        self._buffer    = buffer

    # ── Public ────────────────────────────────────────────────────────────────

    async def upload(self, result: PipelineResult) -> UploadResult:
        """
        Post to moisture-service and inventory-service concurrently.

        Never raises — failures are either buffered (if buffer is set)
        or logged as errors.
        """
        tasks = []
        upload_result = UploadResult()

        if result.has_thermal and result.thermal_jpeg:
            tasks.append(("moisture", self._upload_moisture(result, upload_result)))
        else:
            logger.debug("Skipping moisture upload — no thermal data this cycle")

        if result.pile_detected:
            tasks.append(("inventory", self._upload_inventory(result, upload_result)))
        else:
            logger.debug("Skipping inventory upload — no pile detected this cycle")

        if not tasks:
            logger.warning(
                "No upload targets this cycle — "
                "pile not detected and no thermal data available"
            )
            return upload_result

        await asyncio.gather(*(coro for _, coro in tasks), return_exceptions=True)

        logger.info(
            "Upload cycle complete",
            extra={
                "moisture_status":   upload_result.moisture_status,
                "moisture_buffered": upload_result.moisture_buffered,
                "inventory_status":  upload_result.inventory_status,
                "inventory_buffered":upload_result.inventory_buffered,
            },
        )
        return upload_result

    # ── moisture-service ──────────────────────────────────────────────────────

    async def _upload_moisture(
        self, result: PipelineResult, out: UploadResult
    ) -> None:
        files = {
            "image": ("thermal.jpg", result.thermal_jpeg, "image/jpeg")
        }
        data: dict[str, str] = {
            "pile_id": result.pile_id,
            "site_id": result.site_id,
        }
        if result.camera_id_thermal:
            data["camera_id"] = result.camera_id_thermal

        sensor_readings_json: Optional[str] = None
        if self._s.has_ambient_sensors():
            reading: dict = {
                "temperature_c":         self._s.ambient_temp_c,
                "relative_humidity_pct": self._s.ambient_humidity_pct,
                "timestamp":             result.captured_at.isoformat(),
            }
            if self._s.ambient_pressure_hpa is not None:
                reading["atmospheric_pressure_hpa"] = self._s.ambient_pressure_hpa
            sensor_readings_json = json.dumps([reading])
            data["sensor_readings"] = sensor_readings_json

        try:
            resp = await self._moisture.post_multipart("/predict", files=files, data=data)
            out.moisture_status = resp.status_code

            if 200 <= resp.status_code < 300:
                pred = resp.json().get("data", {})
                logger.info(
                    "Moisture prediction received",
                    extra={
                        "moisture_pct": pred.get("moisture_pct"),
                        "zone":         pred.get("zone"),
                        "confidence":   pred.get("confidence"),
                        "pile_id":      result.pile_id,
                    },
                )
                return

            if resp.status_code in _BUFFER_ON_STATUS:
                logger.warning(
                    "Moisture API returned server error — buffering",
                    extra={"status": resp.status_code},
                )
                out.moisture_error    = f"HTTP {resp.status_code}"
                out.moisture_buffered = self._buffer_moisture(
                    result, sensor_readings_json
                )
            else:
                logger.error(
                    "Moisture API returned non-retriable error",
                    extra={"status": resp.status_code, "body": resp.text[:200]},
                )

        except Exception as exc:
            error = str(exc)
            logger.warning(
                "Moisture upload failed — buffering",
                extra={"error": error, "pile_id": result.pile_id},
            )
            out.moisture_error    = error
            out.moisture_buffered = self._buffer_moisture(result, sensor_readings_json)

    def _buffer_moisture(
        self,
        result: PipelineResult,
        sensor_readings_json: Optional[str],
    ) -> bool:
        """Persist a moisture payload to the local buffer. Returns True on success."""
        if not self._buffer:
            return False
        from ..buffer.store import BufferedEntry
        meta = {
            "camera_id":      result.camera_id_thermal,
            "sensor_readings": sensor_readings_json,
        }
        entry = BufferedEntry(
            upload_type="moisture",
            pile_id=result.pile_id,
            site_id=result.site_id,
            captured_at=result.captured_at.isoformat(),
            payload_json=json.dumps(meta),
            thermal_jpeg=result.thermal_jpeg,
        )
        try:
            row_id = self._buffer.enqueue(entry)
            logger.info(
                "Moisture upload buffered offline",
                extra={"buffer_id": row_id, "pile_id": result.pile_id},
            )
            return True
        except Exception as buf_exc:
            logger.error(
                "Failed to buffer moisture upload",
                extra={"error": str(buf_exc)},
            )
            return False

    # ── inventory-service ─────────────────────────────────────────────────────

    async def _upload_inventory(
        self, result: PipelineResult, out: UploadResult
    ) -> None:
        payload: dict = {
            "volumeM3":          result.volume_m3_est,
            "heightM":           result.height_m_est   if result.height_m_est   > 0 else None,
            "surfaceAreaM2":     result.surface_area_m2_est if result.surface_area_m2_est > 0 else None,
            "confidenceScore":   result.segmentation_confidence if result.segmentation_confidence > 0 else None,
            "measurementSource": "camera",
            "cameraId":          result.camera_id_rgb,
            "time":              result.captured_at.isoformat(),
            "rawImagePath":      None,
            "estimatedTonnes":   None,
        }
        path = f"/piles/{result.pile_id}/volume"

        try:
            resp = await self._inventory.put_json(path, payload)
            out.inventory_status = resp.status_code

            if 200 <= resp.status_code < 300:
                data = resp.json().get("data", {})
                logger.info(
                    "Inventory volume recorded",
                    extra={
                        "pile_id":    result.pile_id,
                        "volume_m3":  data.get("volumeM3"),
                        "height_m":   data.get("heightM"),
                        "confidence": data.get("confidenceScore"),
                    },
                )
                return

            if resp.status_code in _BUFFER_ON_STATUS:
                logger.warning(
                    "Inventory API returned server error — buffering",
                    extra={"status": resp.status_code},
                )
                out.inventory_error    = f"HTTP {resp.status_code}"
                out.inventory_buffered = self._buffer_inventory(payload, result)
            else:
                logger.error(
                    "Inventory API returned non-retriable error",
                    extra={"status": resp.status_code, "body": resp.text[:200]},
                )

        except Exception as exc:
            error = str(exc)
            logger.warning(
                "Inventory upload failed — buffering",
                extra={"error": error, "pile_id": result.pile_id},
            )
            out.inventory_error    = error
            out.inventory_buffered = self._buffer_inventory(payload, result)

    def _buffer_inventory(
        self, payload: dict, result: PipelineResult
    ) -> bool:
        """Persist an inventory payload to the local buffer. Returns True on success."""
        if not self._buffer:
            return False
        from ..buffer.store import BufferedEntry
        entry = BufferedEntry(
            upload_type="inventory",
            pile_id=result.pile_id,
            site_id=result.site_id,
            captured_at=result.captured_at.isoformat(),
            payload_json=json.dumps(payload),
            thermal_jpeg=None,
        )
        try:
            row_id = self._buffer.enqueue(entry)
            logger.info(
                "Inventory upload buffered offline",
                extra={"buffer_id": row_id, "pile_id": result.pile_id},
            )
            return True
        except Exception as buf_exc:
            logger.error(
                "Failed to buffer inventory upload",
                extra={"error": str(buf_exc)},
            )
            return False
