"""
Uploader — converts PipelineResult into the exact payloads expected by
moisture-service and inventory-service, then posts them concurrently.

API contracts:
  moisture-service  POST /predict   multipart/form-data
      image           (file)  pseudocolour JPEG of thermal frame
      pile_id         (str)   UUID
      site_id         (str)   UUID
      camera_id       (str)   UUID, optional
      sensor_readings (str)   JSON array of SensorReadingInput, optional

  inventory-service  PUT /piles/:pileId/volume   application/json
      volumeM3            number  >= 0
      estimatedTonnes     number | null
      heightM             number | null
      surfaceAreaM2       number | null
      confidenceScore     number | null  (0–1)
      measurementSource   "camera"
      cameraId            string | null  UUID
      time                string  ISO 8601
      rawImagePath        null
"""

from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime, timezone
from typing import Optional

from ..config.settings import Settings
from ..processing.pipeline import PipelineResult
from .client import ApiClient

logger = logging.getLogger(__name__)


class UploadResult:
    """Outcome of a single upload cycle."""
    def __init__(self) -> None:
        self.moisture_status: Optional[int] = None
        self.moisture_error: Optional[str] = None
        self.inventory_status: Optional[int] = None
        self.inventory_error: Optional[str] = None

    @property
    def success(self) -> bool:
        ok_m = self.moisture_status is None or (200 <= self.moisture_status < 300)
        ok_i = self.inventory_status is None or (200 <= self.inventory_status < 300)
        return ok_m and ok_i

    def __repr__(self) -> str:
        return (
            f"UploadResult("
            f"moisture={self.moisture_status}, "
            f"inventory={self.inventory_status})"
        )


class Uploader:
    """
    Posts `PipelineResult` data to the relevant backend services.

    Both uploads are fire-and-forget with respect to the pipeline cycle —
    failures are logged but do not abort the scheduler.

    Parameters
    ----------
    settings
        Application settings.
    moisture_client
        `ApiClient` pointed at moisture-service.
    inventory_client
        `ApiClient` pointed at inventory-service.
    """

    def __init__(
        self,
        settings: Settings,
        moisture_client: ApiClient,
        inventory_client: ApiClient,
    ) -> None:
        self._s = settings
        self._moisture = moisture_client
        self._inventory = inventory_client

    async def upload(self, result: PipelineResult) -> UploadResult:
        """
        Post to moisture-service (if thermal data available) and
        inventory-service (if pile was detected) concurrently.

        Never raises — all exceptions are captured into the returned
        `UploadResult`.
        """
        tasks = []

        if result.has_thermal and result.thermal_jpeg:
            tasks.append(self._upload_moisture(result))
        else:
            logger.debug("Skipping moisture upload — no thermal data in this cycle")

        if result.pile_detected:
            tasks.append(self._upload_inventory(result))
        else:
            logger.debug("Skipping inventory upload — no pile detected in this cycle")

        if not tasks:
            logger.warning(
                "No upload targets for this cycle — "
                "pile not detected and no thermal data available"
            )
            return UploadResult()

        outcomes = await asyncio.gather(*tasks, return_exceptions=True)

        upload_result = UploadResult()
        for outcome in outcomes:
            if isinstance(outcome, dict):
                if "moisture_status" in outcome:
                    upload_result.moisture_status = outcome["moisture_status"]
                    upload_result.moisture_error  = outcome.get("moisture_error")
                elif "inventory_status" in outcome:
                    upload_result.inventory_status = outcome["inventory_status"]
                    upload_result.inventory_error  = outcome.get("inventory_error")
            elif isinstance(outcome, Exception):
                logger.error("Upload task raised exception", extra={"error": str(outcome)})

        logger.info(
            "Upload cycle complete",
            extra={
                "moisture_status":  upload_result.moisture_status,
                "inventory_status": upload_result.inventory_status,
                "success":          upload_result.success,
            },
        )
        return upload_result

    # ── moisture-service ──────────────────────────────────────────────────────

    async def _upload_moisture(self, result: PipelineResult) -> dict:
        """POST thermal JPEG + metadata to moisture-service /predict."""
        files = {
            "image": (
                "thermal.jpg",
                result.thermal_jpeg,
                "image/jpeg",
            )
        }
        data: dict[str, str] = {
            "pile_id": result.pile_id,
            "site_id": result.site_id,
        }
        if result.camera_id_thermal:
            data["camera_id"] = result.camera_id_thermal

        if self._s.has_ambient_sensors():
            sensor_reading: dict = {
                "temperature_c":          self._s.ambient_temp_c,
                "relative_humidity_pct":  self._s.ambient_humidity_pct,
            }
            if self._s.ambient_pressure_hpa is not None:
                sensor_reading["atmospheric_pressure_hpa"] = self._s.ambient_pressure_hpa
            # Inject the pipeline timestamp as the reading timestamp
            sensor_reading["timestamp"] = result.captured_at.isoformat()
            data["sensor_readings"] = json.dumps([sensor_reading])

        try:
            resp = await self._moisture.post_multipart("/predict", files=files, data=data)
            status = resp.status_code

            if 200 <= status < 300:
                body = resp.json()
                pred = body.get("data", {})
                logger.info(
                    "Moisture prediction received",
                    extra={
                        "moisture_pct": pred.get("moisture_pct"),
                        "zone":         pred.get("zone"),
                        "confidence":   pred.get("confidence"),
                        "pile_id":      result.pile_id,
                    },
                )
            else:
                logger.warning(
                    "Moisture API returned error",
                    extra={"status": status, "body": resp.text[:300]},
                )

            return {"moisture_status": status}

        except Exception as exc:
            logger.error("Moisture upload failed", extra={"error": str(exc)})
            return {"moisture_status": None, "moisture_error": str(exc)}

    # ── inventory-service ─────────────────────────────────────────────────────

    async def _upload_inventory(self, result: PipelineResult) -> dict:
        """PUT volume measurement to inventory-service /piles/:id/volume."""
        payload: dict = {
            "volumeM3":         result.volume_m3_est,
            "heightM":          result.height_m_est if result.height_m_est > 0 else None,
            "surfaceAreaM2":    result.surface_area_m2_est if result.surface_area_m2_est > 0 else None,
            "confidenceScore":  result.segmentation_confidence if result.segmentation_confidence > 0 else None,
            "measurementSource": "camera",
            "cameraId":         result.camera_id_rgb,
            "time":             result.captured_at.isoformat(),
            "rawImagePath":     None,
        }

        # Estimate tonnes if bulk density is configured
        if self._s.seg_pixel_to_m2 and result.volume_m3_est > 0:
            # We can't infer density here; leave estimatedTonnes null unless
            # the pile has a known bulkDensityT_m3 registered in inventory-service.
            payload["estimatedTonnes"] = None

        path = f"/piles/{result.pile_id}/volume"

        try:
            resp = await self._inventory.put_json(path, payload)
            status = resp.status_code

            if 200 <= status < 300:
                body = resp.json()
                data = body.get("data", {})
                logger.info(
                    "Inventory volume recorded",
                    extra={
                        "pile_id":     result.pile_id,
                        "volume_m3":   data.get("volumeM3"),
                        "height_m":    data.get("heightM"),
                        "confidence":  data.get("confidenceScore"),
                    },
                )
            else:
                logger.warning(
                    "Inventory API returned error",
                    extra={"status": status, "body": resp.text[:300]},
                )

            return {"inventory_status": status}

        except Exception as exc:
            logger.error("Inventory upload failed", extra={"error": str(exc)})
            return {"inventory_status": None, "inventory_error": str(exc)}
