"""
Thermal feature extraction.

Input: a raw 16-bit (or float32) thermal frame.

Pipeline:
  1. raw_to_celsius()      — apply linear calibration (scale + offset)
  2. clamp_valid()         — mask out-of-range pixels (sensor artefacts)
  3. extract_features()    — compute statistical + structural descriptors
  4. encode_jpeg()         — produce a pseudocolour JPEG for the moisture API

Feature definitions
-------------------
temp_mean_c           Mean temperature of valid pixels (full frame or masked to pile).
temp_min_c            Minimum valid temperature.
temp_max_c            Maximum valid temperature.
temp_std_c            Population standard deviation.
temp_p25/p50/p75_c    Temperature percentiles.
gradient_mean         Mean Sobel gradient magnitude (higher = sharper thermal edges;
                      correlates with moisture-driven evaporative cooling boundaries).
uniformity_index      1 - (std / range), clamped to [0, 1].  High values indicate
                      thermally uniform (often wetter) material.
hot_spot_count        Number of connected hot regions above mean + N*sigma.
hot_spot_area_pct     Fraction of valid pixels classified as hot spots (%).
cold_spot_count       Number of connected cold regions below mean - N*sigma.
cold_spot_area_pct    Fraction of valid pixels classified as cold spots (%).
"""

from __future__ import annotations

import io
import logging
from dataclasses import dataclass, field
from typing import Optional

import cv2
import numpy as np
from PIL import Image

from ..config.settings import Settings

logger = logging.getLogger(__name__)


@dataclass
class ThermalFeatures:
    """Statistical and structural descriptors from a single thermal frame."""
    temp_mean_c: float
    temp_min_c: float
    temp_max_c: float
    temp_std_c: float
    temp_p25_c: float
    temp_p50_c: float
    temp_p75_c: float
    gradient_mean: float
    uniformity_index: float
    hot_spot_count: int
    hot_spot_area_pct: float
    cold_spot_count: int
    cold_spot_area_pct: float
    valid_pixel_count: int
    warnings: list[str] = field(default_factory=list)


# Jet colormap lookup table — precomputed for speed
_JET_LUT = None

def _get_jet_lut() -> np.ndarray:
    global _JET_LUT
    if _JET_LUT is None:
        lut = np.zeros((256, 1, 3), dtype=np.uint8)
        for i in range(256):
            lut[i, 0] = cv2.applyColorMap(np.array([[i]], dtype=np.uint8), cv2.COLORMAP_JET)[0, 0]
        _JET_LUT = lut
    return _JET_LUT


class ThermalAnalyzer:
    """
    Stateless thermal frame analyzer.

    All methods take a raw 16-bit or float32 numpy array and return
    calibrated results without mutating state.
    """

    def __init__(self, settings: Settings) -> None:
        self._s = settings

    # ── Calibration ───────────────────────────────────────────────────────────

    def raw_to_celsius(self, raw_frame: np.ndarray) -> np.ndarray:
        """
        Convert a raw thermal frame to °C using the configured scale/offset.

        Input dtype can be uint8, uint16, or float32.
        Output is always float32.
        """
        arr = raw_frame.astype(np.float32)
        if arr.ndim == 3:
            # Some cameras emit a 3-channel frame; take the first channel.
            arr = arr[:, :, 0]
        celsius = arr * self._s.thermal_scale + self._s.thermal_offset
        return celsius

    def clamp_valid(
        self,
        celsius: np.ndarray,
        mask: Optional[np.ndarray] = None,
    ) -> tuple[np.ndarray, np.ndarray]:
        """
        Return (celsius_clamped, valid_mask) where valid_mask is True for
        pixels within [thermal_min_valid_c, thermal_max_valid_c] and,
        optionally, within the provided spatial mask (e.g. pile footprint).

        Out-of-range pixels are set to NaN so they are excluded from statistics.
        """
        lo, hi = self._s.thermal_min_valid_c, self._s.thermal_max_valid_c
        valid = (celsius >= lo) & (celsius <= hi)
        if mask is not None:
            valid = valid & (mask > 0)

        clamped = celsius.copy()
        clamped[~valid] = np.nan
        return clamped, valid

    # ── Feature extraction ────────────────────────────────────────────────────

    def extract_features(
        self,
        raw_frame: np.ndarray,
        spatial_mask: Optional[np.ndarray] = None,
    ) -> ThermalFeatures:
        """
        Extract thermal features from *raw_frame*.

        Parameters
        ----------
        raw_frame
            Raw sensor frame (uint16 or float32).
        spatial_mask
            Optional uint8 binary mask (same H×W as raw_frame).  When provided,
            statistics are computed only over masked-in pixels (the pile region).
        """
        warnings: list[str] = []

        celsius = self.raw_to_celsius(raw_frame)
        celsius_valid, valid_mask = self.clamp_valid(celsius, spatial_mask)

        valid_count = int(np.count_nonzero(valid_mask))
        if valid_count == 0:
            warnings.append("No valid thermal pixels after calibration and masking")
            nan = float("nan")
            return ThermalFeatures(
                temp_mean_c=nan,
                temp_min_c=nan,
                temp_max_c=nan,
                temp_std_c=nan,
                temp_p25_c=nan,
                temp_p50_c=nan,
                temp_p75_c=nan,
                gradient_mean=nan,
                uniformity_index=nan,
                hot_spot_count=0,
                hot_spot_area_pct=0.0,
                cold_spot_count=0,
                cold_spot_area_pct=0.0,
                valid_pixel_count=0,
                warnings=warnings,
            )

        valid_pixels = celsius_valid[valid_mask]

        temp_mean = float(np.nanmean(valid_pixels))
        temp_std  = float(np.nanstd(valid_pixels))
        temp_min  = float(np.nanmin(valid_pixels))
        temp_max  = float(np.nanmax(valid_pixels))
        p25, p50, p75 = np.nanpercentile(valid_pixels, [25, 50, 75]).tolist()

        temp_range = temp_max - temp_min
        uniformity = max(0.0, 1.0 - (temp_std / (temp_range + 1e-6)))

        # Gradient magnitude on the valid Celsius frame (NaN → 0 before Sobel)
        celsius_for_gradient = np.where(valid_mask, celsius_valid, 0.0).astype(np.float32)
        grad_x = cv2.Sobel(celsius_for_gradient, cv2.CV_32F, 1, 0, ksize=3)
        grad_y = cv2.Sobel(celsius_for_gradient, cv2.CV_32F, 0, 1, ksize=3)
        grad_mag = np.sqrt(grad_x ** 2 + grad_y ** 2)
        gradient_mean = float(np.mean(grad_mag[valid_mask]))

        # Hot / cold spot detection
        sigma = self._s.thermal_hot_spot_sigma
        hot_thresh  = temp_mean + sigma * temp_std
        cold_thresh = temp_mean - sigma * temp_std

        hot_map  = (celsius_valid > hot_thresh)  & valid_mask
        cold_map = (celsius_valid < cold_thresh) & valid_mask

        hot_count,  hot_area_pct  = self._count_blobs(hot_map,  valid_count)
        cold_count, cold_area_pct = self._count_blobs(cold_map, valid_count)

        if hot_count > 10:
            warnings.append(f"Unusually high hot-spot count ({hot_count}); check calibration")

        return ThermalFeatures(
            temp_mean_c=round(temp_mean, 3),
            temp_min_c=round(temp_min, 3),
            temp_max_c=round(temp_max, 3),
            temp_std_c=round(temp_std, 3),
            temp_p25_c=round(p25, 3),
            temp_p50_c=round(p50, 3),
            temp_p75_c=round(p75, 3),
            gradient_mean=round(gradient_mean, 4),
            uniformity_index=round(uniformity, 4),
            hot_spot_count=hot_count,
            hot_spot_area_pct=round(hot_area_pct, 3),
            cold_spot_count=cold_count,
            cold_spot_area_pct=round(cold_area_pct, 3),
            valid_pixel_count=valid_count,
            warnings=warnings,
        )

    # ── Image encoding ────────────────────────────────────────────────────────

    def encode_jpeg(
        self,
        raw_frame: np.ndarray,
        spatial_mask: Optional[np.ndarray] = None,
        quality: int = 90,
    ) -> bytes:
        """
        Produce a pseudocolour JPEG of the thermal frame for API submission.

        The frame is normalised to [0, 255] and colourised with the Jet
        colormap — matching the representation moisture-service was trained on.
        Out-of-range pixels become black.

        Parameters
        ----------
        raw_frame
            Raw sensor frame (uint16 or float32).
        spatial_mask
            Optional mask to black-out pixels outside the pile region.
        quality
            JPEG quality factor (1–100).
        """
        celsius = self.raw_to_celsius(raw_frame)
        _, valid_mask = self.clamp_valid(celsius)

        lo, hi = self._s.thermal_min_valid_c, self._s.thermal_max_valid_c
        norm = np.clip((celsius - lo) / (hi - lo), 0.0, 1.0)
        gray8 = (norm * 255).astype(np.uint8)
        colored = cv2.applyColorMap(gray8, cv2.COLORMAP_JET)  # H×W×3 BGR

        # Black out invalid pixels
        invalid_mask = ~valid_mask
        colored[invalid_mask] = 0

        if spatial_mask is not None:
            outside_mask = spatial_mask == 0
            colored[outside_mask] = (colored[outside_mask] * 0.3).astype(np.uint8)

        # Encode as JPEG
        success, buf = cv2.imencode(".jpg", colored, [cv2.IMWRITE_JPEG_QUALITY, quality])
        if not success:
            raise RuntimeError("Failed to JPEG-encode thermal frame")
        return bytes(buf)

    # ── Private helpers ───────────────────────────────────────────────────────

    @staticmethod
    def _count_blobs(binary_map: np.ndarray, total_valid: int) -> tuple[int, float]:
        """
        Count connected components in *binary_map* and their area fraction.

        Returns (count, area_pct) where area_pct is expressed as a
        percentage of *total_valid* pixels (0–100).
        """
        u8 = binary_map.astype(np.uint8) * 255
        n_labels, _, stats, _ = cv2.connectedComponentsWithStats(u8, connectivity=8)
        # Label 0 is background
        count = max(0, n_labels - 1)
        blob_area = int(np.sum(binary_map))
        area_pct = 100.0 * blob_area / (total_valid + 1e-6)
        return count, round(area_pct, 3)
