"""
Processing pipeline — orchestrates segmentation and thermal analysis.

`ProcessingPipeline.run(capture)` accepts a `CaptureResult` and produces a
`PipelineResult` that contains everything needed to make the API calls:

  • pile_detected, segmentation_confidence, pile geometry estimates
  • thermal features (masked to pile footprint where possible)
  • encoded JPEG for the moisture-service `/predict` endpoint
  • annotated debug images when debug output is enabled
"""

from __future__ import annotations

import io
import logging
import os
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Optional

import cv2
import numpy as np

from ..capture.manager import CaptureResult
from ..config.settings import Settings
from .segmentation import PileSegmentor, SegmentationResult
from .thermal import ThermalAnalyzer, ThermalFeatures

logger = logging.getLogger(__name__)


@dataclass
class PipelineResult:
    """Unified result from a single processing run."""

    # Identity
    pile_id: str
    site_id: str
    camera_id_thermal: Optional[str]
    camera_id_rgb: Optional[str]
    captured_at: datetime

    # Segmentation (from RGB)
    pile_detected: bool
    footprint_m2: float = 0.0
    height_m_est: float = 0.0
    volume_m3_est: float = 0.0
    surface_area_m2_est: float = 0.0
    segmentation_confidence: float = 0.0

    # Thermal features
    has_thermal: bool = False
    temp_mean_c: Optional[float] = None
    temp_min_c: Optional[float] = None
    temp_max_c: Optional[float] = None
    temp_std_c: Optional[float] = None
    temp_p25_c: Optional[float] = None
    temp_p50_c: Optional[float] = None
    temp_p75_c: Optional[float] = None
    gradient_mean: Optional[float] = None
    uniformity_index: Optional[float] = None
    hot_spot_count: Optional[int] = None
    hot_spot_area_pct: Optional[float] = None
    cold_spot_count: Optional[int] = None
    cold_spot_area_pct: Optional[float] = None

    # Encoded images
    thermal_jpeg: Optional[bytes] = None   # Pseudocolour JPEG for moisture-service
    rgb_jpeg: Optional[bytes] = None       # Annotated RGB JPEG for logging

    # Metadata
    processing_ms: float = 0.0
    warnings: List[str] = field(default_factory=list)


class ProcessingPipeline:
    """
    Main processing pipeline.

    Parameters
    ----------
    settings
        Loaded application settings.
    save_debug_frames
        When True, save annotated frames to settings.debug_frame_dir and
        include annotated images in the result.
    """

    def __init__(self, settings: Settings, *, save_debug_frames: bool = False) -> None:
        self._s = settings
        self._save_debug = save_debug_frames
        self._segmentor = PileSegmentor(settings, save_annotated=save_debug_frames)
        self._thermal_analyzer = ThermalAnalyzer(settings)
        self._frame_counter = 0

        if save_debug_frames and settings.debug_frame_dir:
            Path(settings.debug_frame_dir).mkdir(parents=True, exist_ok=True)

    # ── Public ────────────────────────────────────────────────────────────────

    def run(self, capture: CaptureResult) -> PipelineResult:
        """
        Run a full detection pass over *capture*.

        Never raises — exceptions are caught and surfaced as warnings.
        """
        t0 = time.monotonic()
        captured_at = datetime.now(timezone.utc)
        warnings: list[str] = []
        self._frame_counter += 1

        # ── Segmentation (RGB) ────────────────────────────────────────────────
        seg_result = self._run_segmentation(capture.rgb_frame, warnings)

        # ── Thermal analysis ──────────────────────────────────────────────────
        thermal_features: Optional[ThermalFeatures] = None
        thermal_jpeg: Optional[bytes] = None

        if capture.has_thermal and capture.thermal_frame is not None:
            # Use the pile mask (if detected) to restrict thermal stats to the pile.
            spatial_mask = seg_result.mask if seg_result.pile_detected else None
            thermal_features, thermal_jpeg = self._run_thermal(
                capture.thermal_frame, spatial_mask, warnings
            )

        # ── RGB JPEG for debug logging ─────────────────────────────────────────
        rgb_jpeg: Optional[bytes] = None
        if self._save_debug and capture.rgb_frame is not None:
            src = seg_result.annotated_frame if seg_result.annotated_frame is not None else capture.rgb_frame
            rgb_jpeg = self._encode_jpeg(src, quality=80)

        # ── Save debug frames to disk ─────────────────────────────────────────
        if self._save_debug and self._s.debug_frame_dir:
            self._save_debug_frames(seg_result, thermal_jpeg, rgb_jpeg)

        processing_ms = (time.monotonic() - t0) * 1000.0

        result = PipelineResult(
            pile_id=self._s.pile_id,
            site_id=self._s.site_id,
            camera_id_thermal=self._s.camera_id_thermal,
            camera_id_rgb=self._s.camera_id_rgb,
            captured_at=captured_at,
            pile_detected=seg_result.pile_detected,
            footprint_m2=seg_result.footprint_m2,
            height_m_est=seg_result.height_m_est,
            volume_m3_est=seg_result.volume_m3_est,
            surface_area_m2_est=seg_result.surface_area_m2_est,
            segmentation_confidence=seg_result.confidence,
            thermal_jpeg=thermal_jpeg,
            rgb_jpeg=rgb_jpeg,
            processing_ms=round(processing_ms, 1),
            warnings=warnings,
        )

        if thermal_features:
            result.has_thermal    = True
            result.temp_mean_c    = thermal_features.temp_mean_c
            result.temp_min_c     = thermal_features.temp_min_c
            result.temp_max_c     = thermal_features.temp_max_c
            result.temp_std_c     = thermal_features.temp_std_c
            result.temp_p25_c     = thermal_features.temp_p25_c
            result.temp_p50_c     = thermal_features.temp_p50_c
            result.temp_p75_c     = thermal_features.temp_p75_c
            result.gradient_mean       = thermal_features.gradient_mean
            result.uniformity_index    = thermal_features.uniformity_index
            result.hot_spot_count      = thermal_features.hot_spot_count
            result.hot_spot_area_pct   = thermal_features.hot_spot_area_pct
            result.cold_spot_count     = thermal_features.cold_spot_count
            result.cold_spot_area_pct  = thermal_features.cold_spot_area_pct
            warnings.extend(thermal_features.warnings)

        if not seg_result.pile_detected and not result.has_thermal:
            logger.warning(
                "Pipeline produced no usable data for this cycle",
                extra={"warnings": warnings},
            )
        else:
            logger.info(
                "Pipeline run complete",
                extra={
                    "pile_detected":      result.pile_detected,
                    "has_thermal":        result.has_thermal,
                    "volume_m3_est":      result.volume_m3_est,
                    "temp_mean_c":        result.temp_mean_c,
                    "processing_ms":      result.processing_ms,
                    "warnings_count":     len(warnings),
                },
            )

        return result

    # ── Private helpers ───────────────────────────────────────────────────────

    def _run_segmentation(
        self,
        rgb_frame: Optional[np.ndarray],
        warnings: list[str],
    ) -> SegmentationResult:
        if rgb_frame is None:
            from .segmentation import SegmentationResult  # local import avoids cycle
            return SegmentationResult(pile_detected=False, warnings=["No RGB frame available"])

        try:
            result = self._segmentor.detect(rgb_frame)
        except Exception as exc:
            logger.exception("Segmentation step failed")
            from .segmentation import SegmentationResult
            return SegmentationResult(pile_detected=False, warnings=[str(exc)])

        warnings.extend(result.warnings)
        return result

    def _run_thermal(
        self,
        thermal_frame: np.ndarray,
        spatial_mask: Optional[np.ndarray],
        warnings: list[str],
    ) -> tuple[Optional[ThermalFeatures], Optional[bytes]]:
        try:
            features = self._thermal_analyzer.extract_features(thermal_frame, spatial_mask)
            jpeg = self._thermal_analyzer.encode_jpeg(thermal_frame, spatial_mask)
            return features, jpeg
        except Exception as exc:
            logger.exception("Thermal analysis step failed")
            warnings.append(f"Thermal analysis failed: {exc}")
            return None, None

    @staticmethod
    def _encode_jpeg(frame: np.ndarray, quality: int = 85) -> Optional[bytes]:
        try:
            ok, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, quality])
            return bytes(buf) if ok else None
        except Exception:
            return None

    def _save_debug_frames(
        self,
        seg: SegmentationResult,
        thermal_jpeg: Optional[bytes],
        rgb_jpeg: Optional[bytes],
    ) -> None:
        debug_dir = Path(self._s.debug_frame_dir)  # type: ignore[arg-type]
        ts = int(time.time())
        idx = self._frame_counter

        try:
            if rgb_jpeg:
                path = debug_dir / f"{ts}_{idx:05d}_rgb.jpg"
                path.write_bytes(rgb_jpeg)

            if thermal_jpeg:
                path = debug_dir / f"{ts}_{idx:05d}_thermal.jpg"
                path.write_bytes(thermal_jpeg)

            # Rotate old files
            frames = sorted(debug_dir.glob("*_rgb.jpg")) + sorted(debug_dir.glob("*_thermal.jpg"))
            if len(frames) > self._s.debug_frame_max * 2:
                for old in frames[: len(frames) - self._s.debug_frame_max * 2]:
                    old.unlink(missing_ok=True)

        except Exception as exc:
            logger.warning("Failed to save debug frame", extra={"error": str(exc)})
