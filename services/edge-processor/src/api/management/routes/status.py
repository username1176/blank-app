"""
GET /status — live system snapshot.

Returns:
  - Runner cycle counters and last-run timing
  - Per-stream health (alive, FPS, reconnect count, last error)
  - Buffer queue depths and total BLOB size
  - Live connectivity probe against moisture-service and inventory-service
"""

from __future__ import annotations

import time
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Request

from ..auth import require_api_key
from ..context import ManagementContext, get_ctx
from ..models import (
    BufferStatus,
    ConnectivityStatus,
    RunnerStats,
    StatusResponse,
    StreamStatus,
)

router = APIRouter()


@router.get(
    "/status",
    response_model=StatusResponse,
    summary="Live system status",
    dependencies=[Depends(require_api_key)],
)
async def get_status(request: Request) -> StatusResponse:
    """
    Returns a full snapshot of the edge processor's current state:
    camera feed health, pipeline cycle stats, offline buffer queue,
    and a live connectivity probe against both cloud services.

    The connectivity probe fires a single lightweight GET /health/live
    against each service with a 5 s timeout — the response reflects
    real-time reachability, not a cached value.
    """
    ctx: ManagementContext = get_ctx(request)

    # ── Connectivity probe (concurrent) ───────────────────────────────────────
    connectivity: dict
    if ctx.syncer is not None:
        connectivity = await ctx.syncer.check_connectivity()
    else:
        connectivity = {"moisture_service": None, "inventory_service": None}

    # ── Runner stats ──────────────────────────────────────────────────────────
    rs = ctx.runner.stats
    runner = RunnerStats(
        running=rs.get("running", False),
        cycles_total=rs.get("cycles_total", 0),
        cycles_ok=rs.get("cycles_ok", 0),
        cycles_failed=rs.get("cycles_failed", 0),
        synced_total=rs.get("synced_total", 0),
        buffered_total=rs.get("buffered_total", 0),
        last_run_at=rs.get("last_run_at") or None,
        last_run_ms=rs.get("last_run_ms", 0.0),
    )

    # ── Stream health ─────────────────────────────────────────────────────────
    raw_streams = ctx.stream_manager.health()
    streams = {
        name: StreamStatus(
            alive=info.get("alive", False),
            fps_actual=info.get("fps_actual", 0.0),
            frames_captured=info.get("frames_captured", 0),
            frames_dropped=info.get("frames_dropped", 0),
            reconnect_count=info.get("reconnect_count", 0),
            last_error=info.get("last_error"),
        )
        for name, info in raw_streams.items()
    }

    # ── Buffer stats ──────────────────────────────────────────────────────────
    buffer_status: BufferStatus | None = None
    if ctx.buffer is not None:
        bs = ctx.buffer.stats()
        buffer_status = BufferStatus(
            pending_count=bs.pending_count,
            syncing_count=bs.syncing_count,
            done_count=bs.done_count,
            failed_count=bs.failed_count,
            total_count=bs.total_count,
            blob_mb=round(bs.blob_bytes / (1024 * 1024), 3),
            oldest_pending_at=bs.oldest_pending_at,
        )

    return StatusResponse(
        timestamp=datetime.now(timezone.utc).isoformat(),
        uptime_s=round(time.monotonic() - ctx.start_time, 1),
        runner=runner,
        streams=streams,
        buffer=buffer_status,
        connectivity=ConnectivityStatus(
            moisture_service=connectivity.get("moisture_service"),
            inventory_service=connectivity.get("inventory_service"),
        ),
    )
