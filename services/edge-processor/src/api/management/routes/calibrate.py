"""
POST /calibrate — trigger a manual out-of-schedule pipeline run.

Purpose
-------
Operators use this endpoint to verify that cameras are feeding valid frames,
that pile segmentation detects the expected boundary, and that thermal
calibration parameters produce plausible temperature readings — all without
waiting for the next scheduled cycle.

The pipeline is identical to the one used in normal operation.  When
`upload=false` (the default) the result is returned in the response body but
NOT posted to moisture-service or inventory-service, so no spurious
historical data points are created.

When `upload=true` the result is posted (or buffered if services are
unreachable), and the response includes `uploaded` / `upload_buffered` flags.
"""

from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request, status
from starlette.concurrency import run_in_threadpool

from ..auth import require_api_key
from ..context import ManagementContext, get_ctx
from ..models import CalibrateRequest, CalibrateResponse

router = APIRouter()


@router.post(
    "/calibrate",
    response_model=CalibrateResponse,
    status_code=status.HTTP_200_OK,
    summary="Trigger a manual pipeline run for calibration / verification",
    dependencies=[Depends(require_api_key)],
)
async def calibrate(
    body: CalibrateRequest,
    request: Request,
) -> CalibrateResponse:
    """
    Captures the current frame from both cameras, runs the full segmentation
    and thermal analysis pipeline, and returns the results immediately.

    **`upload: false` (default)**  — results are returned in the response only;
    nothing is posted to the cloud.  Use this to verify detection without
    creating spurious historical readings.

    **`upload: true`** — results are also sent to moisture-service and
    inventory-service (or buffered locally if they are unreachable).
    """
    ctx: ManagementContext = get_ctx(request)

    # ── Capture ───────────────────────────────────────────────────────────────
    capture = ctx.stream_manager.capture()
    if not capture.has_rgb and not capture.has_thermal:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="No frames available from either camera — streams may still be connecting",
        )

    # ── Process (CPU-bound — run in thread pool so event loop stays free) ─────
    result = await run_in_threadpool(ctx.pipeline.run, capture)

    # ── Optional upload ───────────────────────────────────────────────────────
    uploaded      = False
    upload_buffered = False
    if body.upload and (result.pile_detected or result.has_thermal):
        upload_result = await ctx.uploader.upload(result)
        uploaded        = upload_result.fully_live
        upload_buffered = upload_result.any_buffered

    return CalibrateResponse(
        timestamp=result.captured_at.isoformat(),
        pile_detected=result.pile_detected,
        footprint_m2=result.footprint_m2,
        height_m_est=result.height_m_est,
        volume_m3_est=result.volume_m3_est,
        surface_area_m2_est=result.surface_area_m2_est,
        segmentation_confidence=result.segmentation_confidence,
        has_thermal=result.has_thermal,
        temp_mean_c=result.temp_mean_c,
        temp_min_c=result.temp_min_c,
        temp_max_c=result.temp_max_c,
        temp_std_c=result.temp_std_c,
        uniformity_index=result.uniformity_index,
        hot_spot_count=result.hot_spot_count,
        cold_spot_count=result.cold_spot_count,
        gradient_mean=result.gradient_mean,
        processing_ms=result.processing_ms,
        uploaded=uploaded,
        upload_buffered=upload_buffered,
        warnings=result.warnings,
    )
