"""
StreamManager — lifecycle management for all camera streams.

Holds optional RGB and thermal `RtspStream` instances, starts/stops them
together, and exposes a single `capture()` method that returns a pair of
frames in one call.

V4L2 thermal cameras (USB FLIR Lepton etc.) are wired up here via a
special path: the raw 16-bit frames are exposed directly so the thermal
analyzer can apply its own calibration.
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
    thermal_frame: Optional[np.ndarray]     # uint16 single-channel (raw) or float32 (°C), or None
    rgb_timestamp: float = 0.0              # UNIX epoch
    thermal_timestamp: float = 0.0         # UNIX epoch

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

    Calling `start()` launches all enabled streams.
    `capture()` returns the latest frames without blocking on I/O.
    `stop()` gracefully shuts down all streams.
    """

    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._rgb_stream: Optional[RtspStream] = None
        self._thermal_stream: Optional[RtspStream] = None
        self._setup_streams()

    # ── Lifecycle ─────────────────────────────────────────────────────────────

    def start(self) -> None:
        """Start all configured streams."""
        for stream in self._all_streams():
            stream.start()
        logger.info(
            "StreamManager started",
            extra={
                "rgb":     self._settings.has_rgb(),
                "thermal": self._settings.has_thermal(),
            },
        )

    def stop(self) -> None:
        """Stop all streams and release resources."""
        for stream in self._all_streams():
            stream.stop()
        logger.info("StreamManager stopped")

    # ── Capture ───────────────────────────────────────────────────────────────

    def capture(self) -> CaptureResult:
        """
        Return the most-recent frames from both cameras.

        Never blocks — if a stream has no frame yet (e.g. still connecting),
        the corresponding field is None.
        """
        rgb_frame, rgb_ts = (
            self._rgb_stream.get_frame_with_timestamp()
            if self._rgb_stream
            else (None, 0.0)
        )
        thermal_frame, thermal_ts = (
            self._thermal_stream.get_frame_with_timestamp()
            if self._thermal_stream
            else (None, 0.0)
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

    def _setup_streams(self) -> None:
        s = self._settings

        if s.has_rgb() and s.rgb_rtsp_url:
            self._rgb_stream = RtspStream(
                name="rgb",
                url=s.rgb_rtsp_url,
                use_gstreamer=s.use_gstreamer,
                gst_codec="h264",
                target_fps=s.rgb_target_fps,
                reconnect_delay_s=s.stream_reconnect_delay_s,
                is_16bit=False,
            )

        if s.has_thermal():
            if s.thermal_rtsp_url:
                # IP thermal camera via RTSP (FLIR AX8, Axis Q, etc.)
                # Most RTSP thermal cameras stream MJPEG or H.264-encoded thermal images;
                # the raw pixel values encode temperature data.
                self._thermal_stream = RtspStream(
                    name="thermal-rtsp",
                    url=s.thermal_rtsp_url,
                    # IP thermal cameras typically don't benefit from nvv4l2decoder
                    # (many stream MJPEG, not H.264).  Keep GStreamer off unless
                    # the operator explicitly knows their camera supports it.
                    use_gstreamer=False,
                    target_fps=s.thermal_target_fps,
                    reconnect_delay_s=s.stream_reconnect_delay_s,
                    is_16bit=True,
                )
            elif s.thermal_v4l2_device:
                # USB thermal camera (FLIR Lepton on PureThermal, etc.)
                # V4L2 URL convention: prepend v4l2://
                v4l2_url = f"v4l2://{s.thermal_v4l2_device}"
                self._thermal_stream = RtspStream(
                    name="thermal-v4l2",
                    url=v4l2_url,
                    use_gstreamer=s.use_gstreamer,
                    target_fps=s.thermal_target_fps,
                    reconnect_delay_s=s.stream_reconnect_delay_s,
                    is_16bit=True,
                )

    def _all_streams(self) -> list[RtspStream]:
        streams = []
        if self._rgb_stream:
            streams.append(self._rgb_stream)
        if self._thermal_stream:
            streams.append(self._thermal_stream)
        return streams
