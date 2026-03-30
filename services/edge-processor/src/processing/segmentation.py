"""
Pile boundary detection from RGB frames using OpenCV.

Three methods are supported, selected by `Settings.seg_method`:

  adaptive_threshold — converts to grayscale, applies adaptive Gaussian
      thresholding, and finds the largest contour.  Works best under
      controlled lighting on a homogeneous background floor.

  color_range — converts to HSV colorspace and creates a mask of pixels
      whose hue/saturation/value fall within a configured range.  Best
      when the pile material has a distinctive colour (grain, coal, etc.).

  canny_edges — Canny edge detection + contour hierarchy analysis to find
      closed boundary contours.  More robust to lighting changes.

All three methods finish with the same post-processing:
  1. Morphological opening/closing to remove salt-and-pepper noise.
  2. Contour selection by area (largest contour above the min threshold).
  3. Convex-hull and polygon approximation for a clean boundary.
  4. Real-world area and estimated height/volume calculation.
"""

from __future__ import annotations

import logging
import math
from dataclasses import dataclass, field
from typing import List, Optional, Tuple

import cv2
import numpy as np

from ..config.settings import Settings

logger = logging.getLogger(__name__)


@dataclass
class SegmentationResult:
    """Output of a single segmentation run."""
    pile_detected: bool

    # Pixel-space results
    contour: Optional[np.ndarray] = None          # (N, 1, 2) int32
    convex_hull: Optional[np.ndarray] = None      # (N, 1, 2) int32
    bounding_rect: Optional[Tuple[int, int, int, int]] = None  # x, y, w, h
    footprint_px: int = 0                         # pixel area of contour
    mask: Optional[np.ndarray] = None             # uint8 binary mask (same HxW as frame)

    # Real-world estimates
    footprint_m2: float = 0.0
    height_m_est: float = 0.0
    volume_m3_est: float = 0.0
    surface_area_m2_est: float = 0.0

    # Quality
    confidence: float = 0.0                       # 0–1
    method_used: str = ""
    warnings: List[str] = field(default_factory=list)

    # Annotated frame (for debug output)
    annotated_frame: Optional[np.ndarray] = None


class PileSegmentor:
    """
    Stateless pile boundary detector.

    Parameters
    ----------
    settings
        Application settings providing thresholds and calibration.
    save_annotated
        When True, the result includes an annotated copy of the frame.
    """

    def __init__(self, settings: Settings, *, save_annotated: bool = False) -> None:
        self._s = settings
        self._save_annotated = save_annotated

    # ── Public ────────────────────────────────────────────────────────────────

    def detect(self, frame: np.ndarray) -> SegmentationResult:
        """
        Detect the pile in *frame* (uint8 BGR, HxWx3).

        Returns a `SegmentationResult`.  Never raises — errors are captured
        in the result's `warnings` list.
        """
        if frame is None or frame.ndim != 3:
            return SegmentationResult(
                pile_detected=False,
                method_used=self._s.seg_method,
                warnings=["Invalid or missing frame"],
            )

        method = self._s.seg_method
        try:
            if method == "color_range":
                mask = self._color_range_mask(frame)
            elif method == "canny_edges":
                mask = self._canny_mask(frame)
            else:
                # Default: adaptive_threshold
                mask = self._adaptive_threshold_mask(frame)
        except Exception as exc:
            logger.exception("Segmentation failed", extra={"method": method})
            return SegmentationResult(
                pile_detected=False,
                method_used=method,
                warnings=[f"Segmentation exception: {exc}"],
            )

        return self._extract_result(frame, mask, method)

    # ── Mask generators ───────────────────────────────────────────────────────

    def _adaptive_threshold_mask(self, frame: np.ndarray) -> np.ndarray:
        """
        Adaptive Gaussian threshold on the grayscale image.

        Works well on homogeneous floors where the pile is a darker or brighter
        region than the surroundings.
        """
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        blurred = cv2.GaussianBlur(gray, (7, 7), 0)

        # Adaptive threshold: blocks of 51×51 pixels with C=5 offset
        mask = cv2.adaptiveThreshold(
            blurred,
            maxValue=255,
            adaptiveMethod=cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
            thresholdType=cv2.THRESH_BINARY_INV,
            blockSize=51,
            C=5,
        )
        return self._clean_mask(mask)

    def _color_range_mask(self, frame: np.ndarray) -> np.ndarray:
        """HSV color-range masking for materials with a known colour."""
        hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
        lower = np.array(self._s.hsv_lower(), dtype=np.uint8)
        upper = np.array(self._s.hsv_upper(), dtype=np.uint8)
        mask = cv2.inRange(hsv, lower, upper)
        return self._clean_mask(mask)

    def _canny_mask(self, frame: np.ndarray) -> np.ndarray:
        """
        Canny edge detection followed by contour fill.

        Detects the pile outline from sharp luminance edges and fills the
        enclosed region to create a binary mask.
        """
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        blurred = cv2.GaussianBlur(gray, (5, 5), 0)

        # Auto-compute Canny thresholds via Otsu's binarisation
        otsu_thresh, _ = cv2.threshold(blurred, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
        edges = cv2.Canny(blurred, otsu_thresh * 0.5, otsu_thresh)

        # Dilate edges slightly before filling to close gaps
        kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
        edges = cv2.dilate(edges, kernel, iterations=1)

        # Fill enclosed regions
        contours, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        mask = np.zeros_like(gray)
        cv2.drawContours(mask, contours, -1, 255, cv2.FILLED)
        return self._clean_mask(mask)

    # ── Shared post-processing ────────────────────────────────────────────────

    @staticmethod
    def _clean_mask(mask: np.ndarray) -> np.ndarray:
        """Morphological opening then closing to reduce noise."""
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9))
        mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN,  kernel, iterations=2)
        mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel, iterations=2)
        return mask

    def _extract_result(
        self,
        frame: np.ndarray,
        mask: np.ndarray,
        method: str,
    ) -> SegmentationResult:
        h_frame, w_frame = frame.shape[:2]
        frame_area_px = h_frame * w_frame
        min_area = max(self._s.seg_min_area_px, int(frame_area_px * self._s.seg_min_frame_fraction))
        warnings: list[str] = []

        contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        if not contours:
            return SegmentationResult(
                pile_detected=False,
                mask=mask,
                method_used=method,
                warnings=["No contours found in mask"],
            )

        # Pick the largest contour above the area threshold
        largest = max(contours, key=cv2.contourArea)
        area_px = int(cv2.contourArea(largest))

        if area_px < min_area:
            return SegmentationResult(
                pile_detected=False,
                mask=mask,
                method_used=method,
                footprint_px=area_px,
                warnings=[
                    f"Largest contour area {area_px}px < threshold {min_area}px "
                    f"({area_px / frame_area_px:.1%} of frame)"
                ],
            )

        hull = cv2.convexHull(largest)
        approx = cv2.approxPolyDP(largest, epsilon=0.01 * cv2.arcLength(largest, True), closed=True)
        bx, by, bw, bh = cv2.boundingRect(largest)

        # Real-world estimates
        px_to_m2 = self._s.seg_pixel_to_m2
        footprint_m2 = area_px * px_to_m2
        height_m_est = self._s.seg_heap_height_factor * math.sqrt(footprint_m2)
        volume_m3_est = (1.0 / 3.0) * footprint_m2 * height_m_est   # cone model
        # Surface area of a cone frustum: π * r * slant = π * r * sqrt(r² + h²)
        r_m = math.sqrt(footprint_m2 / math.pi)
        slant = math.sqrt(r_m ** 2 + height_m_est ** 2)
        surface_area_m2_est = math.pi * r_m * slant + footprint_m2  # lateral + base

        # Confidence: penalise if the contour is close to the frame edge
        edge_penalty = 0.0
        if bx < 10 or by < 10 or (bx + bw) > (w_frame - 10) or (by + bh) > (h_frame - 10):
            edge_penalty = 0.2
            warnings.append("Pile contour touches frame edge — measurements may be clipped")

        fill_ratio = area_px / (cv2.contourArea(hull) + 1e-6)
        convexity_score = min(fill_ratio, 1.0)
        confidence = max(0.0, min(1.0, convexity_score - edge_penalty))

        # Build pile mask limited to the winning contour
        pile_mask = np.zeros((h_frame, w_frame), dtype=np.uint8)
        cv2.drawContours(pile_mask, [largest], -1, 255, cv2.FILLED)

        annotated = None
        if self._save_annotated:
            annotated = frame.copy()
            cv2.drawContours(annotated, [approx],      -1, (0, 255,   0), 2)
            cv2.drawContours(annotated, [hull],         -1, (255, 128, 0), 1)
            cv2.rectangle(annotated, (bx, by), (bx + bw, by + bh), (0, 0, 255), 1)
            label = (
                f"{footprint_m2:.1f}m2  "
                f"h~{height_m_est:.2f}m  "
                f"V~{volume_m3_est:.1f}m3  "
                f"conf:{confidence:.2f}"
            )
            cv2.putText(annotated, label, (bx, max(by - 8, 20)),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 0), 1, cv2.LINE_AA)

        return SegmentationResult(
            pile_detected=True,
            contour=largest,
            convex_hull=hull,
            bounding_rect=(bx, by, bw, bh),
            footprint_px=area_px,
            mask=pile_mask,
            footprint_m2=round(footprint_m2, 4),
            height_m_est=round(height_m_est, 3),
            volume_m3_est=round(volume_m3_est, 3),
            surface_area_m2_est=round(surface_area_m2_est, 3),
            confidence=round(confidence, 3),
            method_used=method,
            warnings=warnings,
            annotated_frame=annotated,
        )
