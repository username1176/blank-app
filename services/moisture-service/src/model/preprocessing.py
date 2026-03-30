"""
Image and sensor preprocessing pipeline.

Thermal image path
------------------
bytes → decode (cv2) → grayscale → depth normalise (8 or 16-bit)
      → CLAHE contrast enhancement → resize → standardise → CHW tensor

Sensor reading path
-------------------
list[dict] → validate → extract 6 features per timestep → (1, T, 6) tensor

The six sensor features fed to SensorLSTM (in order):
  0  temperature_c            (ambient temperature, °C)
  1  relative_humidity_pct    (0–100)
  2  atmospheric_pressure_hpa (hPa, e.g. 1013.25)
  3  dew_point_c              (°C; approximated if missing)
  4  wind_speed_ms            (m/s)
  5  delta_seconds            (seconds since the previous reading in the batch)
"""

from __future__ import annotations

import math
from typing import Any

import cv2
import numpy as np
import torch
from pydantic import BaseModel, Field, field_validator

# ---------------------------------------------------------------------------
# Sensor reading schema
# ---------------------------------------------------------------------------

class SensorReadingInput(BaseModel):
    """One timestep of ambient sensor data supplied by the API caller."""

    temperature_c:           float = Field(description="Ambient temperature (°C)")
    relative_humidity_pct:   float = Field(ge=0.0, le=100.0)
    atmospheric_pressure_hpa: float = Field(default=1013.25, ge=800.0, le=1100.0)
    dew_point_c:             float | None = Field(default=None)
    wind_speed_ms:           float        = Field(default=0.0, ge=0.0)
    # ISO 8601 timestamp for the reading; used to compute delta_seconds.
    # If absent the reading is treated as contemporaneous with the previous one.
    timestamp:               str | None   = Field(default=None)

    @field_validator("dew_point_c", mode="before")
    @classmethod
    def fill_dew_point(cls, v: float | None, info: Any) -> float:
        """Approximate dew point from Magnus formula if not supplied."""
        if v is not None:
            return v
        data = info.data
        t = data.get("temperature_c", 20.0)
        rh = data.get("relative_humidity_pct", 50.0)
        # Magnus approximation (Lawrence 2005)
        gamma = math.log(max(rh, 1e-6) / 100.0) + (17.625 * t) / (243.04 + t)
        return 243.04 * gamma / (17.625 - gamma)

# ---------------------------------------------------------------------------
# Sensor tensor builder
# ---------------------------------------------------------------------------

# Feature column order — must match SensorLSTM expectations (sensor_input_dim=6)
_FEATURE_KEYS = [
    "temperature_c",
    "relative_humidity_pct",
    "atmospheric_pressure_hpa",
    "dew_point_c",
    "wind_speed_ms",
]

# Approximate population statistics for z-score normalisation.
# Update these as real-world data accumulates.
_SENSOR_MEAN = np.array([15.0, 60.0, 1013.25, 8.0, 2.0, 30.0], dtype=np.float32)
_SENSOR_STD  = np.array([15.0, 25.0,    10.0,  8.0, 3.0, 60.0], dtype=np.float32)


def build_sensor_tensor(
    readings: list[SensorReadingInput],
) -> torch.Tensor:
    """
    Convert a list of validated sensor readings into a model-ready tensor.

    Returns
    -------
    Tensor, shape (1, T, 6) — batch dim prepended, ready for SensorLSTM.
    """
    from datetime import datetime, timezone  # noqa: PLC0415

    rows: list[list[float]] = []
    prev_ts: datetime | None = None

    for reading in readings:
        # Parse optional timestamp for delta_seconds calculation.
        if reading.timestamp:
            try:
                ts = datetime.fromisoformat(reading.timestamp.replace("Z", "+00:00"))
            except ValueError:
                ts = None
        else:
            ts = None

        delta = 0.0
        if ts is not None and prev_ts is not None:
            delta = max(0.0, (ts - prev_ts).total_seconds())
        prev_ts = ts

        row = [
            reading.temperature_c,
            reading.relative_humidity_pct,
            reading.atmospheric_pressure_hpa,
            reading.dew_point_c if reading.dew_point_c is not None else 0.0,
            reading.wind_speed_ms,
            delta,
        ]
        rows.append(row)

    arr = np.array(rows, dtype=np.float32)              # (T, 6)
    arr = (arr - _SENSOR_MEAN) / (_SENSOR_STD + 1e-8)  # z-score normalise
    tensor = torch.from_numpy(arr).unsqueeze(0)         # (1, T, 6)
    return tensor


def default_sensor_tensor() -> torch.Tensor:
    """
    Return a single zero-row sensor tensor for sensor-less inference.
    Produces (1, 1, 6) — one timestep of zero features.
    """
    return torch.zeros(1, 1, 6, dtype=torch.float32)


# ---------------------------------------------------------------------------
# Thermal image pipeline
# ---------------------------------------------------------------------------

# Standardisation parameters derived from a representative thermal dataset.
# Values approximate those used for IR imagery (single-channel, not ImageNet).
_THERMAL_MEAN: float = 0.40
_THERMAL_STD:  float = 0.20


def preprocess_thermal_image(
    data: bytes,
    input_size: int = 224,
    *,
    apply_clahe: bool = True,
    clahe_clip_limit: float = 3.0,
    clahe_tile_size: int = 8,
) -> torch.Tensor:
    """
    Decode raw image bytes and produce a model-ready float tensor.

    Pipeline
    --------
    1. Decode with OpenCV (handles JPEG / PNG / TIFF / 16-bit TIFF).
    2. Convert to single-channel grayscale.
    3. Normalise pixel depth to float32 [0, 1] (handles 8-bit and 16-bit).
    4. Apply CLAHE to enhance local contrast (important for low-contrast IR).
    5. Resize to (input_size × input_size) with bilinear interpolation.
    6. Standardise with per-channel mean/std.
    7. Return shape (1, 1, input_size, input_size) — batch and channel dims.

    Parameters
    ----------
    data            : Raw bytes from the uploaded file.
    input_size      : Spatial size expected by the model (default 224 px).
    apply_clahe     : Toggle CLAHE (disable for already-enhanced inputs).
    clahe_clip_limit: CLAHE clip limit; higher → more contrast amplification.
    clahe_tile_size : CLAHE grid tile size (pixels).

    Raises
    ------
    ValueError  If OpenCV cannot decode the bytes.
    """
    # ── 1. Decode ──────────────────────────────────────────────────────────────
    arr = np.frombuffer(data, dtype=np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_UNCHANGED)
    if img is None:
        raise ValueError(
            "Could not decode image data. "
            "Supported formats: JPEG, PNG, TIFF, BMP, WebP."
        )

    # ── 2. Grayscale ───────────────────────────────────────────────────────────
    if img.ndim == 3:
        code = cv2.COLOR_BGRA2GRAY if img.shape[2] == 4 else cv2.COLOR_BGR2GRAY
        img = cv2.cvtColor(img, code)
    # img is now (H, W)

    # ── 3. Depth normalisation ─────────────────────────────────────────────────
    if img.dtype == np.uint16:
        img_f = img.astype(np.float32) / 65535.0
    elif img.dtype == np.float32 or img.dtype == np.float64:
        img_f = img.astype(np.float32)
        img_f = (img_f - img_f.min()) / (img_f.ptp() + 1e-8)
    else:
        img_f = img.astype(np.float32) / 255.0

    # ── 4. CLAHE ───────────────────────────────────────────────────────────────
    if apply_clahe:
        img_u8 = (img_f * 255.0).clip(0, 255).astype(np.uint8)
        clahe = cv2.createCLAHE(
            clipLimit=clahe_clip_limit,
            tileGridSize=(clahe_tile_size, clahe_tile_size),
        )
        img_u8 = clahe.apply(img_u8)
        img_f = img_u8.astype(np.float32) / 255.0

    # ── 5. Resize ──────────────────────────────────────────────────────────────
    if img_f.shape[0] != input_size or img_f.shape[1] != input_size:
        img_f = cv2.resize(img_f, (input_size, input_size), interpolation=cv2.INTER_LINEAR)

    # ── 6. Standardise ─────────────────────────────────────────────────────────
    img_f = (img_f - _THERMAL_MEAN) / (_THERMAL_STD + 1e-8)

    # ── 7. Tensor: (H, W) → (1, 1, H, W) ─────────────────────────────────────
    tensor = torch.from_numpy(img_f).float().unsqueeze(0).unsqueeze(0)
    return tensor


def image_stats(data: bytes) -> dict[str, int | str]:
    """
    Return basic metadata about an image without full preprocessing.
    Useful for logging / validation error messages.
    """
    arr = np.frombuffer(data, dtype=np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_UNCHANGED)
    if img is None:
        return {"error": "undecodable"}
    h, w = img.shape[:2]
    channels = 1 if img.ndim == 2 else img.shape[2]
    return {
        "width": w,
        "height": h,
        "channels": channels,
        "dtype": str(img.dtype),
    }
