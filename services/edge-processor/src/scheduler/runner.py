"""
Interval runner — runs the processing pipeline on a fixed schedule.

Design goals:
  - Never overlap runs: if a run takes longer than the interval, the next
    run is deferred until the current one finishes (rather than stacking up).
  - Accurate timing: the sleep duration accounts for pipeline execution time
    so the effective interval stays close to the configured value.
  - Graceful shutdown: `stop()` signals the loop to exit cleanly after the
    current iteration completes.
  - Health file: writes /tmp/edge_health.json after every cycle so the Docker
    HEALTHCHECK can verify the process is running.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from pathlib import Path
from typing import Awaitable, Callable, Optional

from ..capture.manager import CaptureResult, StreamManager
from ..processing.pipeline import PipelineResult, ProcessingPipeline
from ..api.uploader import Uploader

logger = logging.getLogger(__name__)

_HEALTH_FILE = Path("/tmp/edge_health.json")


class IntervalRunner:
    """
    Runs the capture → process → upload cycle on a configurable interval.

    Parameters
    ----------
    interval_s
        Target time between the *start* of successive runs (seconds).
    stream_manager
        Provides frames via `capture()`.
    pipeline
        Converts frames into `PipelineResult`.
    uploader
        Posts results to the backend APIs.
    on_result
        Optional callback invoked after each successful `pipeline.run()`.
        Called before the upload so the caller can inspect or mutate the result.
    """

    def __init__(
        self,
        interval_s: float,
        stream_manager: StreamManager,
        pipeline: ProcessingPipeline,
        uploader: Uploader,
        on_result: Optional[Callable[[PipelineResult], Awaitable[None]]] = None,
    ) -> None:
        self._interval_s = interval_s
        self._stream_manager = stream_manager
        self._pipeline = pipeline
        self._uploader = uploader
        self._on_result = on_result

        self._running = False
        self._stop_event = asyncio.Event()

        # Counters for health reporting
        self._cycles_total: int = 0
        self._cycles_ok: int = 0
        self._cycles_failed: int = 0
        self._last_run_at: float = 0.0
        self._last_run_ms: float = 0.0

    # ── Lifecycle ─────────────────────────────────────────────────────────────

    async def run_forever(self) -> None:
        """
        Start the periodic loop.  Blocks until `stop()` is called or the
        process receives SIGTERM/SIGINT.
        """
        self._running = True
        self._stop_event.clear()
        logger.info("Interval runner started", extra={"interval_s": self._interval_s})

        while not self._stop_event.is_set():
            cycle_start = time.monotonic()
            self._cycles_total += 1

            try:
                await self._run_cycle()
                self._cycles_ok += 1
            except Exception as exc:
                self._cycles_failed += 1
                logger.error(
                    "Unhandled exception in processing cycle",
                    extra={"error": str(exc), "cycle": self._cycles_total},
                    exc_info=True,
                )

            elapsed = time.monotonic() - cycle_start
            self._last_run_ms = elapsed * 1000.0
            self._last_run_at = time.time()
            self._write_health()

            sleep_s = max(0.0, self._interval_s - elapsed)
            if elapsed > self._interval_s:
                logger.warning(
                    "Cycle overran interval",
                    extra={
                        "elapsed_s":    round(elapsed, 2),
                        "interval_s":   self._interval_s,
                        "overrun_s":    round(elapsed - self._interval_s, 2),
                    },
                )
            else:
                logger.debug(
                    "Cycle complete — sleeping",
                    extra={
                        "elapsed_s": round(elapsed, 2),
                        "sleep_s":   round(sleep_s, 2),
                    },
                )

            try:
                await asyncio.wait_for(self._stop_event.wait(), timeout=sleep_s)
            except asyncio.TimeoutError:
                pass  # Normal — sleep period elapsed

        logger.info(
            "Interval runner stopped",
            extra={
                "cycles_total":  self._cycles_total,
                "cycles_ok":     self._cycles_ok,
                "cycles_failed": self._cycles_failed,
            },
        )
        self._running = False

    def stop(self) -> None:
        """Signal the loop to exit after the current cycle."""
        self._stop_event.set()
        logger.info("Stop requested — runner will exit after current cycle")

    @property
    def stats(self) -> dict:
        return {
            "running":        self._running,
            "cycles_total":   self._cycles_total,
            "cycles_ok":      self._cycles_ok,
            "cycles_failed":  self._cycles_failed,
            "last_run_at":    self._last_run_at,
            "last_run_ms":    round(self._last_run_ms, 1),
        }

    # ── Private ───────────────────────────────────────────────────────────────

    async def _run_cycle(self) -> None:
        """One capture → process → upload iteration."""
        capture = self._stream_manager.capture()
        stream_health = self._stream_manager.health()

        if not capture.has_rgb and not capture.has_thermal:
            logger.warning(
                "No frames available from any stream — skipping cycle",
                extra={"stream_health": stream_health},
            )
            return

        if not capture.has_rgb:
            logger.warning("RGB frame not available; segmentation will be skipped")
        if not capture.has_thermal:
            logger.debug("Thermal frame not available; thermal analysis will be skipped")

        # Run synchronous CV processing in a thread pool so it doesn't block
        # the event loop (important if async tasks are sharing the loop).
        loop = asyncio.get_running_loop()
        result: PipelineResult = await loop.run_in_executor(
            None, self._pipeline.run, capture
        )

        if self._on_result:
            await self._on_result(result)

        await self._uploader.upload(result)

    def _write_health(self) -> None:
        try:
            _HEALTH_FILE.write_text(
                json.dumps({
                    "ts":             self._last_run_at,
                    "cycles_total":   self._cycles_total,
                    "cycles_ok":      self._cycles_ok,
                    "cycles_failed":  self._cycles_failed,
                    "last_run_ms":    round(self._last_run_ms, 1),
                })
            )
        except Exception:
            pass  # Non-critical
