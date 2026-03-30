"""
POST /predict — moisture percentage prediction from a thermal image.

Accepts
-------
Multipart form data:
  image           UploadFile  (required)  JPEG / PNG / TIFF thermal image
  pile_id         str UUID    (required)
  site_id         str UUID    (required)
  camera_id       str UUID    (optional)
  sensor_readings str JSON    (optional)  JSON array of SensorReadingInput objects

Returns
-------
200 { data: PredictResponse }

Zone classification thresholds (moisture_pct)
---------------------------------------------
  < DRY_THRESHOLD  (10 %)  → "dry"
  ≤ WET_THRESHOLD  (20 %)  → "normal"
  > WET_THRESHOLD          → "wet"

Error handling
--------------
  Model not loaded  → 503
  Image undecodable → 422
  Validation error  → 422
  DB failure        → prediction still returned; DB error logged as warning
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Literal

import asyncpg
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from pydantic import BaseModel, Field, field_validator

from src.db import get_db
from src.logger import get_logger
from src.middleware.auth import AuthPayload, get_current_user
from src.model import model_registry
from src.model.preprocessing import (
    SensorReadingInput,
    build_sensor_tensor,
    default_sensor_tensor,
    image_stats,
    preprocess_thermal_image,
)
from src.repositories.moisture_repository import MoistureReadingInsert, MoistureRepository

log = get_logger(__name__)
router = APIRouter(tags=["prediction"])

# ---------------------------------------------------------------------------
# Zone classification
# ---------------------------------------------------------------------------

DRY_THRESHOLD: float = 10.0   # moisture_pct < 10  → dry
WET_THRESHOLD: float = 20.0   # moisture_pct > 20  → wet

ZoneClassification = Literal["dry", "normal", "wet"]


def classify_zone(moisture_pct: float) -> ZoneClassification:
    if moisture_pct < DRY_THRESHOLD:
        return "dry"
    if moisture_pct > WET_THRESHOLD:
        return "wet"
    return "normal"


# ---------------------------------------------------------------------------
# Response models
# ---------------------------------------------------------------------------

class ConfidenceInterval(BaseModel):
    lower: float = Field(description="Lower bound of 95 % confidence interval (%)")
    upper: float = Field(description="Upper bound of 95 % confidence interval (%)")


class PredictData(BaseModel):
    pile_id:         str
    site_id:         str
    camera_id:       str | None
    moisture_pct:    float  = Field(description="Predicted moisture percentage (0–100)")
    confidence:      float  = Field(description="Confidence score (0–1)")
    zone:            ZoneClassification
    bounds:          ConfidenceInterval
    std:             float | None = Field(default=None, description="Predicted std dev (percentage points)")
    model_version:   str
    inference_ms:    float
    sensor_count:    int   = Field(description="Number of sensor readings used")
    processed_at:    str


class PredictResponse(BaseModel):
    data: PredictData


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_ALLOWED_CONTENT_TYPES = {
    "image/jpeg", "image/png", "image/tiff", "image/bmp",
    "image/webp", "application/octet-stream",
}
_MAX_IMAGE_BYTES = 20 * 1024 * 1024   # 20 MB


def _validate_image_upload(image: UploadFile) -> None:
    """Raise 422 for obviously wrong uploads before reading the full body."""
    ct = (image.content_type or "").split(";")[0].strip().lower()
    if ct and ct not in _ALLOWED_CONTENT_TYPES:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={
                "code": "UNSUPPORTED_IMAGE_TYPE",
                "message": f"Content-Type '{ct}' is not supported. "
                           f"Use JPEG, PNG, or TIFF.",
            },
        )


def _parse_sensor_readings(raw: str | None) -> list[SensorReadingInput]:
    """Parse and validate the JSON sensor_readings form field."""
    if not raw:
        return []
    try:
        items = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={
                "code": "INVALID_SENSOR_JSON",
                "message": f"sensor_readings is not valid JSON: {exc}",
            },
        )
    if not isinstance(items, list):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={
                "code": "INVALID_SENSOR_FORMAT",
                "message": "sensor_readings must be a JSON array",
            },
        )
    try:
        return [SensorReadingInput.model_validate(item) for item in items]
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"code": "INVALID_SENSOR_DATA", "message": str(exc)},
        )


# ---------------------------------------------------------------------------
# Route
# ---------------------------------------------------------------------------

@router.post(
    "/predict",
    response_model=PredictResponse,
    status_code=status.HTTP_200_OK,
    summary="Predict moisture percentage from a thermal image",
)
async def predict_moisture(
    image: UploadFile = File(
        ...,
        description="Thermal image file (JPEG / PNG / TIFF, max 20 MB)",
    ),
    pile_id: str = Form(..., description="UUID of the pile being measured"),
    site_id: str = Form(..., description="UUID of the site"),
    camera_id: str | None = Form(
        default=None,
        description="UUID of the camera that captured the image",
    ),
    sensor_readings: str | None = Form(
        default=None,
        description=(
            "Optional JSON array of ambient sensor readings to feed the LSTM. "
            "Each element: {temperature_c, relative_humidity_pct, "
            "atmospheric_pressure_hpa?, dew_point_c?, wind_speed_ms?, timestamp?}"
        ),
    ),
    auth: AuthPayload = Depends(get_current_user),
    conn: asyncpg.Connection = Depends(get_db),
) -> PredictResponse:

    # ── Guard: model must be loaded ───────────────────────────────────────────
    if not model_registry.is_loaded():
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={
                "code": "MODEL_NOT_LOADED",
                "message": "Moisture model is not loaded. Check MODEL_PATH configuration.",
            },
        )

    # ── Validate & read image ─────────────────────────────────────────────────
    _validate_image_upload(image)

    image_bytes = await image.read()
    if len(image_bytes) > _MAX_IMAGE_BYTES:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={
                "code": "IMAGE_TOO_LARGE",
                "message": f"Image exceeds the 20 MB limit ({len(image_bytes):,} bytes received)",
            },
        )

    # ── Parse sensor readings ─────────────────────────────────────────────────
    sensor_list = _parse_sensor_readings(sensor_readings)

    # ── Preprocess with OpenCV ────────────────────────────────────────────────
    settings_obj = model_registry._active  # noqa: SLF001 — read-only access for input_size
    input_size: int = 224
    if settings_obj is not None:
        input_size = settings_obj.config.thermal_feature_dim  # type: ignore[assignment]
        # ModelConfig doesn't store input_size — use the app settings
        from src.config import get_settings as _gs  # noqa: PLC0415
        input_size = _gs().MODEL_INPUT_SIZE

    try:
        image_tensor = preprocess_thermal_image(image_bytes, input_size=input_size)
    except ValueError as exc:
        stats = image_stats(image_bytes)
        log.warning(
            "Image preprocessing failed",
            filename=image.filename,
            stats=stats,
            error=str(exc),
        )
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"code": "IMAGE_DECODE_ERROR", "message": str(exc)},
        )

    # ── Build sensor tensor ───────────────────────────────────────────────────
    if sensor_list:
        sensor_tensor = build_sensor_tensor(sensor_list)
    else:
        sensor_tensor = default_sensor_tensor()

    # Determine ambient conditions for DB logging (last reading in the sequence)
    ambient_temp: float | None = None
    ambient_humidity: float | None = None
    if sensor_list:
        last = sensor_list[-1]
        ambient_temp     = last.temperature_c
        ambient_humidity = last.relative_humidity_pct

    # ── Inference ─────────────────────────────────────────────────────────────
    result = model_registry.predict(
        sensor_seq=sensor_tensor,
        images=image_tensor,
    )

    zone = classify_zone(result.moisture_pct)
    processed_at = datetime.now(tz=timezone.utc).isoformat()

    log.info(
        "Moisture prediction complete",
        pile_id=pile_id,
        site_id=site_id,
        customer_id=auth.customer_id,
        moisture_pct=result.moisture_pct,
        confidence=result.confidence,
        zone=zone,
        sensor_count=len(sensor_list),
        inference_ms=result.inference_ms,
        model_version=result.model_version,
    )

    # ── Persist to DB ─────────────────────────────────────────────────────────
    repo = MoistureRepository(conn)
    try:
        await repo.insert(
            MoistureReadingInsert(
                customer_id=auth.customer_id,
                site_id=site_id,
                pile_id=pile_id,
                camera_id=camera_id,
                moisture_pct=result.moisture_pct,
                confidence_score=result.confidence,
                zone_classification=zone,
                model_version=result.model_version,
                # Store the original filename as a lightweight provenance record.
                # A separate object-store upload step would write the full path.
                thermal_image_path=image.filename or None,
                ambient_temp_c=ambient_temp,
                ambient_humidity_pct=ambient_humidity,
            )
        )
    except Exception as exc:  # noqa: BLE001
        # DB failure must not suppress the response — the prediction is still
        # valid and the caller needs it immediately.  Log loudly and continue.
        log.warning(
            "Failed to persist moisture reading to DB — prediction still returned",
            pile_id=pile_id,
            customer_id=auth.customer_id,
            error=str(exc),
        )

    # ── Response ──────────────────────────────────────────────────────────────
    return PredictResponse(
        data=PredictData(
            pile_id=pile_id,
            site_id=site_id,
            camera_id=camera_id,
            moisture_pct=result.moisture_pct,
            confidence=result.confidence,
            zone=zone,
            bounds=ConfidenceInterval(
                lower=result.lower_bound,
                upper=result.upper_bound,
            ),
            std=result.std,
            model_version=result.model_version,
            inference_ms=result.inference_ms,
            sensor_count=len(sensor_list),
            processed_at=processed_at,
        )
    )
