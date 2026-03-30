"""
Interval runner — runs the processing pipeline on a fixed schedule.

Each cycle:
  1. (Optional) BufferSyncer.sync_pending() — drain any buffered uploads
     before capturing a new frame, so cloud receives data in arrival order.
  2. capture() — grab the latest frame from both cameras.
  3. pipeline.run() — segmentation + thermal analysis (in thread pool).
  4. uploader.upload() — post live; buffer on failure.

Timing:
  The sleep between cycles accounts for actual execution time so the
  *start-to-start* interval stays close to `interval_s`.  If a cycle
  overruns the interval, the next one starts immediately (no overlap —
  cycles are sequential).

Health file:
  Writes /tmp/edge_health.json after every cycle for the Docker HEALTHCHECK.

Graceful shutdown:
  `stop()` sets an asyncio.Event that the sleep wait checks.  The current
  cycle finishes normally, then the loop exits.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from pathlib import Path
from typing import Awaitable, Callable, Optional, TYPE_CHECKING

from ..capture.manager import CaptureResult, StreamManager
from ..processing.pipeline import PipelineResult, ProcessingPipeline
from ..api.uploader import Uploader

if TYPE_CHECKING:
    from ..buffer.syncer import BufferSyncer

logger = logging.getLogger(__name__)

_HEALTH_FILE = Path("/tmp/edge_health.json")


class IntervalRunner:
    """
    Periodic capture → sync → process → upload loop.

    Parameters
    ----------
    interval_s
        Target time between the *start* of successive cycles (seconds).
    stream_manager
        Provides frames via `capture()`.
    pipeline
        Converts frames into `PipelineResult` (CPU-bound, runs in executor).
    uploader
        Posts results to the backend APIs.
    syncer
        Optional `BufferSyncer`.  When provided, a sync pass runs at the
        *beginning* of each cycle so buffered data is delivered in order
        before fresh data.
    on_result
        Optional async callback invoked after `pipeline.run()` and before
        `uploader.upload()`.  Useful for testing / custom side-effects.
    """

    def __init__(
        self,
        interval_s: float,
        stream_manager: StreamManager,
        pipeline: ProcessingPipeline,
        uploader: Uploader,
        syncer: Optional["BufferSyncer"] = None,
        on_result: Optional[Callable[[PipelineResult], Awaitable[None]]] = None,
    ) -> None:
        self._interval_s    = interval_s
        self._stream_manager = stream_manager
        self._pipeline       = pipeline
        self._uploader       = uploader
        self._syncer         = syncer
        self._on_result      = on_result

        self._running        = False
        self._stop_event     = asyncio.Event()

        # Counters
        self._cycles_total:    int   = 0
        self._cycles_ok:       int   = 0
        self._cycles_failed:   int   = 0
        self._synced_total:    int   = 0
        self._buffered_total:  int   = 0
        self._last_run_at:     float = 0.0
        self._last_run_ms:     float = 0.0

    # ── Lifecycle ─────────────────────────────────────────────────────────────

    async def run_forever(self) -> None:
        """Start the loop. Blocks until `stop()` is called."""
        self._running = True
        self._stop_event.clear()
        logger.info(
            "Interval runner started",
            extra={"interval_s": self._interval_s, "sync_enabled": self._syncer is not None},
        )

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
                        "elapsed_s":  round(elapsed, 2),
                        "interval_s": self._interval_s,
                        "overrun_s":  round(elapsed - self._interval_s, 2),
                    },
                )
            else:
                logger.debug(
                    "Cycle done — sleeping",
                    extra={"elapsed_s": round(elapsed, 2), "sleep_s": round(sleep_s, 2)},
                )

            try:
                await asyncio.wait_for(self._stop_event.wait(), timeout=sleep_s)
            except asyncio.TimeoutError:
                pass  # Normal — sleep period elapsed

        logger.info(
            "Interval runner stopped",
            extra={
                "cycles_total":   self._cycles_total,
                "cycles_ok":      self._cycles_ok,
                "cycles_failed":  self._cycles_failed,
                "synced_total":   self._synced_total,
                "buffered_total": self._buffered_total,
            },
        )
        self._running = False

    def stop(self) -> None:
        """Signal the loop to exit cleanly after the current cycle."""
        self._stop_event.set()
        logger.info("Stop requested — runner will exit after current cycle")

    @property
    def stats(self) -> dict:
        return {
            "running":        self._running,
            "cycles_total":   self._cycles_total,
            "cycles_ok":      self._cycles_ok,
            "cycles_failed":  self._cycles_failed,
            "synced_total":   self._synced_total,
            "buffered_total": self._buffered_total,
            "last_run_at":    self._last_run_at,
            "last_run_ms":    round(self._last_run_ms, 1),
        }

    # ── Private ───────────────────────────────────────────────────────────────

    async def _run_cycle(self) -> None:
        """One sync → capture → process → upload iteration."""

        # ── 1. Sync buffered data first (in-order delivery) ───────────────────
        if self._syncer is not None:
            try:
                sync_result = await self._syncer.sync_pending()
                if not sync_result.skipped:
                    self._synced_total += sync_result.synced
                    if sync_result.synced or sync_result.failed:
                        logger.info(
                            "Buffer sync",
                            extra={
                                "synced":   sync_result.synced,
                                "failed":   sync_result.failed,
                                "released": sync_result.released,
                            },
                        )
            except Exception as exc:
                logger.warning(
                    "Buffer sync step raised unexpectedly",
                    extra={"error": str(exc)},
                )

        # ── 2. Capture ────────────────────────────────────────────────────────
        capture = self._stream_manager.capture()
        stream_health = self._stream_manager.health()

        if not capture.has_rgb and not capture.has_thermal:
            logger.warning(
                "No frames from any stream — skipping pipeline",
                extra={"stream_health": stream_health},
            )
            return

        if not capture.has_rgb:
            logger.warning("RGB unavailable; segmentation will be skipped")
        if not capture.has_thermal:
            logger.debug("Thermal unavailable; thermal analysis will be skipped")

        # ── 3. Process (CPU-bound: run in thread pool) ─────────────────────────
        loop = asyncio.get_running_loop()
        result: PipelineResult = await loop.run_in_executor(
            None, self._pipeline.run, capture
        )

        if self._on_result:
            await self._on_result(result)

        # ── 4. Upload (live or buffer) ─────────────────────────────────────────
        upload_result = await self._uploader.upload(result)

        if upload_result.any_buffered:
            self._buffered_total += sum([
                upload_result.moisture_buffered,
                upload_result.inventory_buffered,
            ])

    def _write_health(self) -> None:
        try:
            _HEALTH_FILE.write_text(
                json.dumps({
                    "ts":             self._last_run_at,
                    "cycles_total":   self._cycles_total,
                    "cycles_ok":      self._cycles_ok,
                    "cycles_failed":  self._cycles_failed,
                    "synced_total":   self._synced_total,
                    "buffered_total": self._buffered_total,
                    "last_run_ms":    round(self._last_run_ms, 1),
                })
            )
        except Exception:
            pass  # Non-critical
