"""
edge-processor entry point.

Startup sequence:
  1. Load and validate settings from environment / .env file.
  2. Configure structured JSON logging.
  3. Create all components (streams, pipeline, API clients, uploader, runner).
  4. Start RTSP capture streams.
  5. Run the interval loop (blocks until SIGTERM / SIGINT).

Shutdown sequence (SIGTERM / SIGINT):
  1. Signal the interval runner to stop after the current cycle.
  2. Stop all camera streams.
  3. Exit 0 — any unhandled exception exits 1.
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
    """Set up structured JSON logging for production; plain text for dev."""
    handler = logging.StreamHandler(sys.stdout)
    if os.getenv("NODE_ENV") == "development" or os.getenv("LOG_FORMAT") == "text":
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

    # Silence noisy third-party loggers
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)


logger = logging.getLogger(__name__)


async def _main() -> None:
    # ── Settings ──────────────────────────────────────────────────────────────
    try:
        settings = Settings()
    except Exception as exc:
        # Logging isn't configured yet — write to stderr directly
        print(f"FATAL: Invalid configuration — {exc}", file=sys.stderr)
        sys.exit(1)

    _configure_logging(settings.log_level)

    logger.info(
        "edge-processor starting",
        extra={
            "site_id":          settings.site_id,
            "pile_id":          settings.pile_id,
            "seg_method":       settings.seg_method,
            "interval_s":       settings.process_interval_s,
            "use_gstreamer":    settings.use_gstreamer,
            "has_rgb":          settings.has_rgb(),
            "has_thermal":      settings.has_thermal(),
            "moisture_api":     settings.moisture_api_url,
            "inventory_api":    settings.inventory_api_url,
        },
    )

    # ── Components ────────────────────────────────────────────────────────────
    stream_manager = StreamManager(settings)

    save_debug = bool(settings.debug_frame_dir)
    pipeline = ProcessingPipeline(settings, save_debug_frames=save_debug)

    moisture_client  = ApiClient(settings, settings.moisture_api_url)
    inventory_client = ApiClient(settings, settings.inventory_api_url)
    uploader = Uploader(settings, moisture_client, inventory_client)

    runner = IntervalRunner(
        interval_s=settings.process_interval_s,
        stream_manager=stream_manager,
        pipeline=pipeline,
        uploader=uploader,
    )

    # ── Graceful shutdown ─────────────────────────────────────────────────────
    loop = asyncio.get_running_loop()

    def _handle_signal(sig_name: str) -> None:
        logger.info(f"Received {sig_name} — initiating graceful shutdown")
        runner.stop()

    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, lambda s=sig.name: _handle_signal(s))

    # ── Start streams ─────────────────────────────────────────────────────────
    stream_manager.start()

    logger.info(
        "Streams started — waiting for first frames before beginning pipeline",
        extra={"warm_up_s": 3},
    )
    # Brief warm-up pause: give the RTSP clients time to connect and buffer
    # at least one frame before the first pipeline cycle fires.
    await asyncio.sleep(3.0)

    # ── Run ───────────────────────────────────────────────────────────────────
    try:
        await runner.run_forever()
    finally:
        stream_manager.stop()
        logger.info("edge-processor stopped", extra={"stats": runner.stats})


def main() -> None:
    """Entry point registered by the module import (python -m src.main)."""
    try:
        asyncio.run(_main())
    except KeyboardInterrupt:
        pass
    except Exception as exc:
        print(f"FATAL: {exc}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
