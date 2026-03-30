"""
edge-processor entry point.

Startup sequence:
  1. Load and validate settings from environment / .env file.
  2. Apply persistent runtime overrides from the JSON overrides file.
  3. Configure structured JSON logging.
  4. Open the SQLite offline buffer (if BUFFER_ENABLED=true).
  5. Create all components: streams, pipeline, API clients, uploader, syncer.
  6. Start the management REST API server (if MGMT_API_ENABLED=true).
  7. Start RTSP/V4L2 capture streams.
  8. Run the interval loop (blocks until SIGTERM / SIGINT).

Shutdown sequence (SIGTERM / SIGINT):
  1. Signal the interval runner to stop after the current cycle.
  2. Signal the uvicorn management server to stop.
  3. Await both tasks.
  4. Stop all camera streams.
  5. Close the SQLite buffer.
  6. Exit 0 — any unhandled exception exits 1.
"""

from __future__ import annotations

import asyncio
import logging
import os
import signal
import sys
import time

from pythonjsonlogger import jsonlogger

from .config.settings import Settings
from .config.store import ConfigStore
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
    # Suppress uvicorn access log noise; keep error log
    logging.getLogger("uvicorn.access").setLevel(logging.WARNING)


logger = logging.getLogger(__name__)


async def _main() -> None:
    # ── Settings ──────────────────────────────────────────────────────────────
    try:
        settings = Settings()
    except Exception as exc:
        print(f"FATAL: Invalid configuration — {exc}", file=sys.stderr)
        sys.exit(1)

    _configure_logging(settings.log_level)

    # ── Runtime overrides (from previous PUT /update-config calls) ────────────
    config_store = ConfigStore(settings.config_overrides_path)
    overrides = config_store.load()
    if overrides:
        for key, value in overrides.items():
            try:
                setattr(settings, key, value)
            except Exception as exc:
                logger.warning(
                    "Ignoring invalid config override",
                    extra={"key": key, "value": value, "error": str(exc)},
                )

    logger.info(
        "edge-processor starting",
        extra={
            "site_id":        settings.site_id,
            "pile_id":        settings.pile_id,
            "seg_method":     settings.seg_method,
            "interval_s":     settings.process_interval_s,
            "use_gstreamer":  settings.use_gstreamer,
            "has_rgb":        settings.has_rgb(),
            "has_thermal":    settings.has_thermal(),
            "buffer_enabled": settings.buffer_enabled,
            "mgmt_api":       f"{settings.mgmt_api_host}:{settings.mgmt_api_port}"
                               if settings.mgmt_api_enabled else "disabled",
        },
    )

    # ── Offline buffer ────────────────────────────────────────────────────────
    buffer = None
    if settings.buffer_enabled:
        from .buffer.store import BufferStore
        buffer = BufferStore(
            db_path=settings.buffer_db_path,
            max_rows=settings.buffer_max_rows,
            max_size_mb=settings.buffer_max_size_mb,
            prune_done_after_hours=settings.buffer_prune_done_after_h,
        )
        try:
            buffer.open()
            recovered = buffer.reset_syncing()
            bs = buffer.stats()
            logger.info(
                "Buffer opened",
                extra={
                    "pending":        bs.pending_count,
                    "recovered_rows": recovered,
                    "blob_mb":        round(bs.blob_bytes / (1024 * 1024), 2),
                },
            )
        except Exception as exc:
            logger.error(
                "Failed to open offline buffer — continuing without it",
                extra={"error": str(exc)},
            )
            buffer = None

    # ── API clients ───────────────────────────────────────────────────────────
    moisture_client  = ApiClient(settings, settings.moisture_api_url)
    inventory_client = ApiClient(settings, settings.inventory_api_url)

    uploader = Uploader(
        settings, moisture_client, inventory_client, buffer=buffer
    )

    # ── Buffer syncer ─────────────────────────────────────────────────────────
    syncer = None
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

    # ── Pipeline + streams ────────────────────────────────────────────────────
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

    # ── Management API ────────────────────────────────────────────────────────
    mgmt_server = None
    mgmt_task: asyncio.Task | None = None

    if settings.mgmt_api_enabled:
        try:
            import uvicorn
            from .api.management.context import ManagementContext
            from .api.management.server import create_management_app

            ctx = ManagementContext(
                settings=settings,
                runner=runner,
                stream_manager=stream_manager,
                pipeline=pipeline,
                moisture_client=moisture_client,
                inventory_client=inventory_client,
                uploader=uploader,
                buffer=buffer,
                syncer=syncer,
                config_store=config_store,
                start_time=time.monotonic(),
            )
            mgmt_app = create_management_app(ctx)
            uvicorn_cfg = uvicorn.Config(
                app=mgmt_app,
                host=settings.mgmt_api_host,
                port=settings.mgmt_api_port,
                log_level="warning",
                access_log=False,
            )
            mgmt_server = uvicorn.Server(uvicorn_cfg)
            mgmt_task = asyncio.create_task(
                mgmt_server.serve(), name="mgmt-api"
            )
            logger.info(
                "Management API started",
                extra={
                    "host": settings.mgmt_api_host,
                    "port": settings.mgmt_api_port,
                    "docs": os.getenv("MGMT_API_DOCS", "false"),
                },
            )
        except ImportError:
            logger.warning(
                "uvicorn / fastapi not installed — management API disabled. "
                "Install with: pip install fastapi uvicorn[standard]"
            )

    # ── Signal handlers ───────────────────────────────────────────────────────
    loop = asyncio.get_running_loop()

    def _handle_signal(sig_name: str) -> None:
        logger.info(f"Received {sig_name} — initiating graceful shutdown")
        runner.stop()
        if mgmt_server is not None:
            mgmt_server.should_exit = True

    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, lambda s=sig.name: _handle_signal(s))

    # ── Start streams ─────────────────────────────────────────────────────────
    stream_manager.start()
    logger.info("Streams started — warming up 3 s before first pipeline cycle")
    await asyncio.sleep(3.0)

    # ── Run until stop ────────────────────────────────────────────────────────
    runner_task = asyncio.create_task(runner.run_forever(), name="runner")

    try:
        await runner_task
    finally:
        # Stop management server if it's still running
        if mgmt_server is not None:
            mgmt_server.should_exit = True
        if mgmt_task is not None:
            await mgmt_task

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
