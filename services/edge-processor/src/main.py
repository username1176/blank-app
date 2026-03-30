"""
edge-processor entry point.

Startup sequence:
  1. Load and validate settings from environment / .env file.
  2. Configure structured JSON logging.
  3. Open the SQLite offline buffer (if BUFFER_ENABLED=true).
  4. Create all components: streams, pipeline, API clients, uploader, syncer, runner.
  5. Start RTSP/V4L2 capture streams.
  6. Run the interval loop (blocks until SIGTERM / SIGINT).

Shutdown sequence (SIGTERM / SIGINT):
  1. Signal the interval runner to stop after the current cycle.
  2. Stop all camera streams.
  3. Close the SQLite buffer.
  4. Exit 0 — any unhandled exception exits 1.
"""

from __future__ import annotations

import asyncio
import logging
import os
import signal
import sys

from pythonjsonlogger import jsonlogger

from .config.settings import Settings
from .capture.manager import StreamManager
from .processing.pipeline import ProcessingPipeline
from .api.client import ApiClient
from .api.uploader import Uploader
from .scheduler.runner import IntervalRunner


def _configure_logging(level: str) -> None:
    handler = logging.StreamHandler(sys.stdout)
    if os.getenv("LOG_FORMAT") == "text":
        formatter = logging.Formatter(
            "%(asctime)s  %(levelname)-8s  %(name)s  %(message)s"
        )
    else:
        formatter = jsonlogger.JsonFormatter(
            fmt="%(asctime)s %(levelname)s %(name)s %(message)s",
            datefmt="%Y-%m-%dT%H:%M:%S",
        )
    handler.setFormatter(formatter)
    root = logging.getLogger()
    root.handlers.clear()
    root.addHandler(handler)
    root.setLevel(getattr(logging, level.upper(), logging.INFO))
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)


logger = logging.getLogger(__name__)


async def _main() -> None:
    # ── Settings ──────────────────────────────────────────────────────────────
    try:
        settings = Settings()
    except Exception as exc:
        print(f"FATAL: Invalid configuration — {exc}", file=sys.stderr)
        sys.exit(1)

    _configure_logging(settings.log_level)

    logger.info(
        "edge-processor starting",
        extra={
            "site_id":         settings.site_id,
            "pile_id":         settings.pile_id,
            "seg_method":      settings.seg_method,
            "interval_s":      settings.process_interval_s,
            "use_gstreamer":   settings.use_gstreamer,
            "has_rgb":         settings.has_rgb(),
            "has_thermal":     settings.has_thermal(),
            "buffer_enabled":  settings.buffer_enabled,
            "buffer_db":       settings.buffer_db_path if settings.buffer_enabled else None,
            "moisture_api":    settings.moisture_api_url,
            "inventory_api":   settings.inventory_api_url,
        },
    )

    # ── Offline buffer ────────────────────────────────────────────────────────
    buffer = None
    syncer = None

    if settings.buffer_enabled:
        from .buffer.store import BufferStore
        from .buffer.syncer import BufferSyncer

        buffer = BufferStore(
            db_path=settings.buffer_db_path,
            max_rows=settings.buffer_max_rows,
            max_size_mb=settings.buffer_max_size_mb,
            prune_done_after_hours=settings.buffer_prune_done_after_h,
        )
        try:
            buffer.open()
            recovered = buffer.reset_syncing()
            buf_stats = buffer.stats()
            logger.info(
                "Buffer opened",
                extra={
                    "pending":         buf_stats.pending_count,
                    "recovered_rows":  recovered,
                    "blob_mb":         round(buf_stats.blob_bytes / (1024 * 1024), 2),
                    "oldest_pending":  buf_stats.oldest_pending_at,
                },
            )
        except Exception as exc:
            logger.error(
                "Failed to open offline buffer — continuing without it",
                extra={"error": str(exc)},
            )
            buffer = None

    # ── API clients + uploader ────────────────────────────────────────────────
    moisture_client  = ApiClient(settings, settings.moisture_api_url)
    inventory_client = ApiClient(settings, settings.inventory_api_url)

    uploader = Uploader(
        settings,
        moisture_client,
        inventory_client,
        buffer=buffer,
    )

    # ── Syncer (only when buffer is available) ────────────────────────────────
    if buffer is not None:
        from .buffer.syncer import BufferSyncer
        syncer = BufferSyncer(
            store=buffer,
            moisture_client=moisture_client,
            inventory_client=inventory_client,
            batch_size=settings.sync_batch_size,
            max_attempts=settings.sync_max_attempts,
            connectivity_timeout_s=settings.sync_connectivity_timeout_s,
        )

    # ── Processing pipeline + stream manager ──────────────────────────────────
    stream_manager = StreamManager(settings)
    save_debug = bool(settings.debug_frame_dir)
    pipeline = ProcessingPipeline(settings, save_debug_frames=save_debug)

    runner = IntervalRunner(
        interval_s=settings.process_interval_s,
        stream_manager=stream_manager,
        pipeline=pipeline,
        uploader=uploader,
        syncer=syncer,
    )

    # ── Signal handlers ───────────────────────────────────────────────────────
    loop = asyncio.get_running_loop()

    def _handle_signal(sig_name: str) -> None:
        logger.info(f"Received {sig_name} — initiating graceful shutdown")
        runner.stop()

    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, lambda s=sig.name: _handle_signal(s))

    # ── Start streams ─────────────────────────────────────────────────────────
    stream_manager.start()

    logger.info("Streams started — warming up for 3 s before first pipeline cycle")
    await asyncio.sleep(3.0)

    # ── Run until stop ────────────────────────────────────────────────────────
    try:
        await runner.run_forever()
    finally:
        stream_manager.stop()
        if buffer is not None:
            buffer.close()
        logger.info("edge-processor stopped", extra={"stats": runner.stats})


def main() -> None:
    try:
        asyncio.run(_main())
    except KeyboardInterrupt:
        pass
    except Exception as exc:
        print(f"FATAL: {exc}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
