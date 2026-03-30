"""
StreamManager — lifecycle management for all camera streams.

Holds optional RGB and thermal `RtspStream` instances, starts/stops them
together, and exposes a single `capture()` method that returns a pair of
frames in one call.

V4L2 thermal cameras (USB FLIR Lepton etc.) are wired up here via a
special path: the raw 16-bit frames are exposed directly so the thermal
analyzer can apply its own calibration.

Runtime stream restart
----------------------
`restart_rgb()` and `restart_thermal()` stop the current stream, rebuild
it from the current `Settings` object, and start it again.  The management
API uses these after updating camera URLs so changes take effect immediately
without a full process restart.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Optional

import numpy as np

from ..config.settings import Settings
from .stream import RtspStream

logger = logging.getLogger(__name__)


@dataclass
class CaptureResult:
    """A snapshot from both cameras at a single point in time."""
    rgb_frame: Optional[np.ndarray]         # uint8 BGR, or None
    thermal_frame: Optional[np.ndarray]     # uint16 single-channel (raw), or None
    rgb_timestamp: float = 0.0
    thermal_timestamp: float = 0.0

    @property
    def has_rgb(self) -> bool:
        return self.rgb_frame is not None

    @property
    def has_thermal(self) -> bool:
        return self.thermal_frame is not None

    @property
    def is_complete(self) -> bool:
        return self.has_rgb and self.has_thermal


class StreamManager:
    """
    Creates and manages `RtspStream` instances from `Settings`.

    Streams are built lazily from the *current* state of the `Settings`
    object, so changing `settings.rgb_rtsp_url` and then calling
    `restart_rgb()` picks up the new URL without touching the thermal stream.
    """

    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._rgb_stream: Optional[RtspStream] = None
        self._thermal_stream: Optional[RtspStream] = None
        self._build_all_streams()

    # ── Lifecycle ─────────────────────────────────────────────────────────────

    def start(self) -> None:
        """Start all configured streams."""
        for stream in self._active_streams():
            stream.start()
        logger.info(
            "StreamManager started",
            extra={"rgb": self._settings.has_rgb(), "thermal": self._settings.has_thermal()},
        )

    def stop(self) -> None:
        """Stop all streams and release resources."""
        for stream in self._active_streams():
            stream.stop()
        logger.info("StreamManager stopped")

    # ── Per-stream restart (called by management API on URL change) ────────────

    def restart_rgb(self) -> None:
        """
        Stop the current RGB stream, rebuild it from the current settings,
        and start it again.  No-op if no RGB source is configured.
        """
        if self._rgb_stream:
            self._rgb_stream.stop()
        self._rgb_stream = self._build_rgb_stream()
        if self._rgb_stream:
            self._rgb_stream.start()
            logger.info(
                "RGB stream restarted",
                extra={"url": self._settings.rgb_rtsp_url},
            )
        else:
            logger.info("RGB stream disabled (no URL configured)")

    def restart_thermal(self) -> None:
        """
        Stop the current thermal stream, rebuild it from the current settings,
        and start it again.  No-op if no thermal source is configured.
        """
        if self._thermal_stream:
            self._thermal_stream.stop()
        self._thermal_stream = self._build_thermal_stream()
        if self._thermal_stream:
            self._thermal_stream.start()
            logger.info(
                "Thermal stream restarted",
                extra={
                    "url":    self._settings.thermal_rtsp_url,
                    "v4l2":   self._settings.thermal_v4l2_device,
                },
            )
        else:
            logger.info("Thermal stream disabled (no source configured)")

    # ── Capture ───────────────────────────────────────────────────────────────

    def capture(self) -> CaptureResult:
        """
        Return the most-recent frames from both cameras.

        Never blocks — if a stream has no frame yet the corresponding field
        is None.
        """
        rgb_frame, rgb_ts = (
            self._rgb_stream.get_frame_with_timestamp()
            if self._rgb_stream else (None, 0.0)
        )
        thermal_frame, thermal_ts = (
            self._thermal_stream.get_frame_with_timestamp()
            if self._thermal_stream else (None, 0.0)
        )
        return CaptureResult(
            rgb_frame=rgb_frame,
            thermal_frame=thermal_frame,
            rgb_timestamp=rgb_ts,
            thermal_timestamp=thermal_ts,
        )

    # ── Health ────────────────────────────────────────────────────────────────

    def health(self) -> dict:
        result: dict = {}
        if self._rgb_stream:
            h = self._rgb_stream.health
            result["rgb"] = {
                "alive":           self._rgb_stream.is_alive,
                "frames_captured": h.frames_captured,
                "frames_dropped":  h.frames_dropped,
                "reconnect_count": h.reconnect_count,
                "fps_actual":      round(h.fps_actual, 2),
                "last_error":      h.last_error,
            }
        if self._thermal_stream:
            h = self._thermal_stream.health
            result["thermal"] = {
                "alive":           self._thermal_stream.is_alive,
                "frames_captured": h.frames_captured,
                "frames_dropped":  h.frames_dropped,
                "reconnect_count": h.reconnect_count,
                "fps_actual":      round(h.fps_actual, 2),
                "last_error":      h.last_error,
            }
        return result

    # ── Private helpers ───────────────────────────────────────────────────────

    def _build_all_streams(self) -> None:
        self._rgb_stream     = self._build_rgb_stream()
        self._thermal_stream = self._build_thermal_stream()

    def _build_rgb_stream(self) -> Optional[RtspStream]:
        s = self._settings
        if not s.has_rgb() or not s.rgb_rtsp_url:
            return None
        return RtspStream(
            name="rgb",
            url=s.rgb_rtsp_url,
            use_gstreamer=s.use_gstreamer,
            gst_codec="h264",
            target_fps=s.rgb_target_fps,
            reconnect_delay_s=s.stream_reconnect_delay_s,
            is_16bit=False,
        )

    def _build_thermal_stream(self) -> Optional[RtspStream]:
        s = self._settings
        if not s.has_thermal():
            return None
        if s.thermal_rtsp_url:
            return RtspStream(
                name="thermal-rtsp",
                url=s.thermal_rtsp_url,
                use_gstreamer=False,
                target_fps=s.thermal_target_fps,
                reconnect_delay_s=s.stream_reconnect_delay_s,
                is_16bit=True,
            )
        if s.thermal_v4l2_device:
            return RtspStream(
                name="thermal-v4l2",
                url=f"v4l2://{s.thermal_v4l2_device}",
                use_gstreamer=s.use_gstreamer,
                target_fps=s.thermal_target_fps,
                reconnect_delay_s=s.stream_reconnect_delay_s,
                is_16bit=True,
            )
        return None

    def _active_streams(self) -> list[RtspStream]:
        return [s for s in (self._rgb_stream, self._thermal_stream) if s is not None]
