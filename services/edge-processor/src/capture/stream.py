"""
RTSP / V4L2 stream capture with background reader thread.

Each `RtspStream` instance owns one background thread that continuously reads
frames from the source and stores the *latest* frame in a thread-safe slot.
Callers call `get_frame()` whenever they need the most-recent image — they never
block on I/O.

GStreamer pipelines are used on Jetson (USE_GSTREAMER=true) to route decode
through the nvv4l2decoder hardware engine.  On standard x86 machines the
built-in OpenCV RTSP / V4L2 backend is used as a fallback.
"""

from __future__ import annotations

import logging
import threading
import time
from dataclasses import dataclass, field
from typing import Optional

import cv2
import numpy as np

logger = logging.getLogger(__name__)


@dataclass
class StreamHealth:
    """Cumulative health counters for a single stream."""
    frames_captured: int = 0
    frames_dropped: int = 0
    reconnect_count: int = 0
    fps_actual: float = 0.0
    last_frame_at: float = 0.0   # UNIX timestamp of the last successful read
    last_error: Optional[str] = None


def _gst_rtsp_pipeline(url: str, codec: str = "h264") -> str:
    """Return a GStreamer pipeline string for hardware-decoded RTSP on Jetson."""
    if codec == "h265":
        depay, parse, decode = "rtph265depay", "h265parse", "nvv4l2decoder"
    else:
        depay, parse, decode = "rtph264depay", "h264parse", "nvv4l2decoder"
    return (
        f"rtspsrc location={url} latency=200 protocols=tcp ! "
        f"{depay} ! {parse} ! {decode} ! "
        "nvvidconv ! video/x-raw,format=BGRx ! "
        "videoconvert ! video/x-raw,format=BGR ! "
        "appsink drop=true max-buffers=1 sync=false"
    )


def _gst_v4l2_gray16_pipeline(device: str, width: int, height: int) -> str:
    """GStreamer pipeline for a USB thermal camera outputting GRAY16_LE."""
    return (
        f"v4l2src device={device} ! "
        f"video/x-raw,format=GRAY16_LE,width={width},height={height} ! "
        "appsink drop=true max-buffers=1 sync=false"
    )


class RtspStream:
    """
    Non-blocking camera reader.

    The background thread runs `_capture_loop()` which continuously reads frames
    and stores the latest one.  `get_frame()` is O(1) and never blocks on I/O.

    Parameters
    ----------
    name
        Human-readable label used in log messages.
    url
        RTSP URL (``rtsp://...``), V4L2 path prefixed ``v4l2://`` (e.g.
        ``v4l2:///dev/video1``), or a raw GStreamer pipeline string.
    use_gstreamer
        When True, wrap the RTSP URL in a GStreamer nvv4l2decoder pipeline.
        Ignored if a full GStreamer pipeline string is passed directly.
    gst_codec
        "h264" or "h265" — used only when ``use_gstreamer=True``.
    target_fps
        Background thread sleeps to honour this rate, reducing CPU waste.
    reconnect_delay_s
        Seconds to wait between reconnect attempts after a stream error.
    is_16bit
        When True (thermal cameras), frames are kept as 16-bit single-channel
        arrays rather than being treated as BGR.
    """

    def __init__(
        self,
        name: str,
        url: str,
        *,
        use_gstreamer: bool = False,
        gst_codec: str = "h264",
        target_fps: int = 5,
        reconnect_delay_s: float = 3.0,
        is_16bit: bool = False,
    ) -> None:
        self._name = name
        self._url = url
        self._use_gstreamer = use_gstreamer
        self._gst_codec = gst_codec
        self._target_fps = target_fps
        self._reconnect_delay_s = reconnect_delay_s
        self._is_16bit = is_16bit

        self._frame: Optional[np.ndarray] = None
        self._frame_timestamp: float = 0.0
        self._lock = threading.Lock()
        self._stop_event = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._health = StreamHealth()

    # ── Public API ────────────────────────────────────────────────────────────

    def start(self) -> None:
        """Start the background capture thread (idempotent)."""
        if self._thread and self._thread.is_alive():
            return
        self._stop_event.clear()
        self._thread = threading.Thread(
            target=self._capture_loop,
            name=f"stream-{self._name}",
            daemon=True,
        )
        self._thread.start()
        logger.info("Stream started", extra={"stream": self._name, "url": self._url[:60]})

    def stop(self) -> None:
        """Signal the background thread to stop and wait for it."""
        self._stop_event.set()
        if self._thread:
            self._thread.join(timeout=8.0)
        logger.info("Stream stopped", extra={"stream": self._name})

    def get_frame(self) -> Optional[np.ndarray]:
        """
        Return a copy of the latest captured frame, or None if no frame is
        available yet.  Never blocks on I/O.
        """
        with self._lock:
            return self._frame.copy() if self._frame is not None else None

    def get_frame_with_timestamp(self) -> tuple[Optional[np.ndarray], float]:
        """Return (frame_copy, capture_unix_time) — useful for latency checks."""
        with self._lock:
            if self._frame is None:
                return None, 0.0
            return self._frame.copy(), self._frame_timestamp

    @property
    def is_alive(self) -> bool:
        """True if the stream is connected and receiving frames."""
        if self._health.last_frame_at == 0.0:
            return False
        stale_threshold = max(5.0, 3.0 / max(self._target_fps, 1))
        return (time.time() - self._health.last_frame_at) < stale_threshold

    @property
    def health(self) -> StreamHealth:
        return self._health

    # ── Private ───────────────────────────────────────────────────────────────

    def _open_capture(self) -> cv2.VideoCapture:
        """Return an opened VideoCapture; caller must check `.isOpened()`."""
        url = self._url

        if self._use_gstreamer and url.startswith("rtsp://"):
            pipeline = _gst_rtsp_pipeline(url, self._gst_codec)
            return cv2.VideoCapture(pipeline, cv2.CAP_GSTREAMER)

        if url.startswith("v4l2://"):
            device_path = url[len("v4l2://"):]
            cap = cv2.VideoCapture(device_path)
        else:
            cap = cv2.VideoCapture(url)

        # Disable internal buffering to always get the freshest frame.
        cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
        return cap

    def _capture_loop(self) -> None:
        """Runs in the daemon thread — open, read, reconnect on failure."""
        frame_interval_s = 1.0 / max(self._target_fps, 1)
        fps_frame_count = 0
        fps_window_start = time.monotonic()

        while not self._stop_event.is_set():
            cap = self._open_capture()

            if not cap.isOpened():
                self._health.reconnect_count += 1
                self._health.last_error = "Failed to open capture"
                logger.warning(
                    "Could not open stream, retrying",
                    extra={
                        "stream": self._name,
                        "delay_s": self._reconnect_delay_s,
                        "reconnects": self._health.reconnect_count,
                    },
                )
                self._stop_event.wait(self._reconnect_delay_s)
                continue

            logger.info(
                "Stream connected",
                extra={
                    "stream": self._name,
                    "reconnect_count": self._health.reconnect_count,
                },
            )

            loop_start = time.monotonic()

            while not self._stop_event.is_set():
                ret, frame = cap.read()
                now = time.monotonic()

                if not ret or frame is None:
                    self._health.frames_dropped += 1
                    self._health.last_error = "Read returned no frame"
                    break

                if self._is_16bit and frame.dtype != np.uint16:
                    # Some drivers give us 16-bit packed into an 8-bit BGR frame.
                    # Re-interpret as uint16 single-channel.
                    frame = frame.view(np.uint16)
                    if frame.ndim == 3:
                        frame = frame[:, :, 0]

                capture_time = time.time()
                with self._lock:
                    self._frame = frame
                    self._frame_timestamp = capture_time

                self._health.frames_captured += 1
                self._health.last_frame_at = capture_time

                # FPS accounting
                fps_frame_count += 1
                elapsed = time.monotonic() - fps_window_start
                if elapsed >= 5.0:
                    self._health.fps_actual = fps_frame_count / elapsed
                    fps_frame_count = 0
                    fps_window_start = time.monotonic()

                # Throttle to target FPS
                frame_elapsed = time.monotonic() - loop_start
                sleep_s = frame_interval_s - (frame_elapsed % frame_interval_s)
                if 0.001 < sleep_s < frame_interval_s:
                    self._stop_event.wait(sleep_s)
                loop_start = time.monotonic()

            cap.release()

            if not self._stop_event.is_set():
                self._health.reconnect_count += 1
                logger.warning(
                    "Stream disconnected, scheduling reconnect",
                    extra={
                        "stream": self._name,
                        "delay_s": self._reconnect_delay_s,
                        "reconnects": self._health.reconnect_count,
                    },
                )
                self._stop_event.wait(self._reconnect_delay_s)
