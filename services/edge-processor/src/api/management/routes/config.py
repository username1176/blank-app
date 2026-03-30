"""
GET  /config          — return the full current configuration (sanitised).
PUT  /update-config   — apply a partial settings update at runtime.

Sanitisation
------------
Camera RTSP URLs may contain embedded credentials (rtsp://user:pass@host/...).
GET /config redacts the userinfo component so credentials are never returned
over the wire.

Security credentials (JWT, API keys) are never included in any response.

Runtime update side effects
---------------------------
Changing a camera URL or stream parameter triggers a stream restart so the
change takes effect immediately without a process restart.

Changing moisture_api_url or inventory_api_url updates the corresponding
ApiClient's base_url; new requests use the updated URL from that point on.

Changing process_interval_s updates the runner's internal interval; the
new value is picked up at the start of the next sleep.

All other settings (segmentation thresholds, thermal calibration) are read
directly from the Settings object on each pipeline call, so they take effect
immediately.

Persistence
-----------
Every applied change is written to the JSON overrides file
(CONFIG_OVERRIDES_PATH, default /data/edge_config.json) so it survives a
container restart.  On startup, main.py loads this file and re-applies the
overrides before starting any service.
"""

from __future__ import annotations

import re
from typing import Any
from urllib.parse import urlparse, urlunparse

from fastapi import APIRouter, Depends, Request, status

from ..auth import require_api_key
from ..context import ManagementContext, get_ctx
from ..models import ConfigResponse, UpdateConfigRequest, UpdateConfigResponse

router = APIRouter()

# Fields that require the affected stream to be restarted
_RGB_STREAM_FIELDS = {
    "rgb_rtsp_url",
    "use_gstreamer",
    "rgb_target_fps",
    "stream_reconnect_delay_s",
}
_THERMAL_STREAM_FIELDS = {
    "thermal_rtsp_url",
    "thermal_v4l2_device",
    "use_gstreamer",
    "thermal_target_fps",
    "stream_reconnect_delay_s",
}


def _redact_url(url: str | None) -> str | None:
    """Remove userinfo (user:pass@) from RTSP/HTTP URLs."""
    if not url:
        return url
    try:
        p = urlparse(url)
        if p.username or p.password:
            # Rebuild without the credentials
            netloc = p.hostname or ""
            if p.port:
                netloc = f"{netloc}:{p.port}"
            return urlunparse(p._replace(netloc=netloc))
    except Exception:
        pass
    return url


def _build_config_response(ctx: ManagementContext) -> ConfigResponse:
    s = ctx.settings
    return ConfigResponse(
        site_id=s.site_id,
        pile_id=s.pile_id,
        camera_id_thermal=s.camera_id_thermal,
        camera_id_rgb=s.camera_id_rgb,
        rgb_rtsp_url=_redact_url(s.rgb_rtsp_url),
        thermal_rtsp_url=_redact_url(s.thermal_rtsp_url),
        thermal_v4l2_device=s.thermal_v4l2_device,
        use_gstreamer=s.use_gstreamer,
        rgb_target_fps=s.rgb_target_fps,
        thermal_target_fps=s.thermal_target_fps,
        stream_reconnect_delay_s=s.stream_reconnect_delay_s,
        process_interval_s=s.process_interval_s,
        seg_method=s.seg_method,
        seg_min_area_px=s.seg_min_area_px,
        seg_min_frame_fraction=s.seg_min_frame_fraction,
        seg_pixel_to_m2=s.seg_pixel_to_m2,
        seg_heap_height_factor=s.seg_heap_height_factor,
        seg_color_hsv_lower=s.seg_color_hsv_lower,
        seg_color_hsv_upper=s.seg_color_hsv_upper,
        thermal_scale=s.thermal_scale,
        thermal_offset=s.thermal_offset,
        thermal_min_valid_c=s.thermal_min_valid_c,
        thermal_max_valid_c=s.thermal_max_valid_c,
        thermal_hot_spot_sigma=s.thermal_hot_spot_sigma,
        moisture_api_url=s.moisture_api_url,
        inventory_api_url=s.inventory_api_url,
        has_ambient_sensors=s.has_ambient_sensors(),
        ambient_temp_c=s.ambient_temp_c,
        ambient_humidity_pct=s.ambient_humidity_pct,
        ambient_pressure_hpa=s.ambient_pressure_hpa,
        buffer_enabled=s.buffer_enabled,
        buffer_max_rows=s.buffer_max_rows,
        buffer_max_size_mb=s.buffer_max_size_mb,
        buffer_prune_done_after_h=s.buffer_prune_done_after_h,
        sync_batch_size=s.sync_batch_size,
        sync_max_attempts=s.sync_max_attempts,
        sync_connectivity_timeout_s=s.sync_connectivity_timeout_s,
        mgmt_api_host=s.mgmt_api_host,
        mgmt_api_port=s.mgmt_api_port,
    )


@router.get(
    "/config",
    response_model=ConfigResponse,
    summary="Return the current configuration (secrets redacted)",
    dependencies=[Depends(require_api_key)],
)
async def get_config(request: Request) -> ConfigResponse:
    """
    Returns the full active configuration.

    Sensitive values are omitted or redacted:
    - RTSP credentials embedded in URLs are removed
    - `mgmt_api_key`, `api_jwt_token` are never included
    """
    return _build_config_response(get_ctx(request))


@router.put(
    "/update-config",
    response_model=UpdateConfigResponse,
    status_code=status.HTTP_200_OK,
    summary="Apply a partial runtime configuration update",
    dependencies=[Depends(require_api_key)],
)
async def update_config(
    body: UpdateConfigRequest,
    request: Request,
) -> UpdateConfigResponse:
    """
    Apply a partial settings update at runtime.

    Only the fields present in the request body (non-null) are applied.
    Changes are persisted to the JSON overrides file immediately so they
    survive a container restart.

    **Camera URL / stream parameter changes** trigger an immediate stream
    restart — the old stream is stopped, a new one is built with the updated
    settings, and started.  Expect a brief interruption in frame capture.

    **API endpoint changes** take effect immediately; the next pipeline
    upload will use the new URL.

    **Processing and calibration changes** take effect on the next pipeline
    cycle.
    """
    ctx: ManagementContext = get_ctx(request)
    s = ctx.settings

    # Collect only the explicitly-set (non-None) fields
    updates: dict[str, Any] = {
        field: value
        for field, value in body.model_dump().items()
        if value is not None
    }

    if not updates:
        # Nothing to do — return current config unchanged
        return UpdateConfigResponse(
            applied={},
            stream_restarted=[],
            config=_build_config_response(ctx),
        )

    # ── Apply to settings object ───────────────────────────────────────────────
    for field, value in updates.items():
        setattr(s, field, value)

    # ── Side effects ──────────────────────────────────────────────────────────
    stream_restarted: list[str] = []

    # Process interval — update the runner's live interval
    if "process_interval_s" in updates:
        ctx.runner._interval_s = s.process_interval_s

    # API endpoint URLs — update client base URLs
    if "moisture_api_url" in updates:
        ctx.moisture_client.base_url = s.moisture_api_url

    if "inventory_api_url" in updates:
        ctx.inventory_client.base_url = s.inventory_api_url

    # Camera/stream settings — restart affected streams
    changed_fields = set(updates.keys())

    if changed_fields & _RGB_STREAM_FIELDS:
        ctx.stream_manager.restart_rgb()
        stream_restarted.append("rgb")

    if changed_fields & _THERMAL_STREAM_FIELDS:
        ctx.stream_manager.restart_thermal()
        stream_restarted.append("thermal")

    # ── Persist to overrides file ─────────────────────────────────────────────
    try:
        ctx.config_store.merge(updates)
    except Exception as exc:
        # Non-fatal: the in-memory change is already applied; just log the failure
        import logging
        logging.getLogger(__name__).error(
            "Failed to persist config update to disk",
            extra={"error": str(exc), "fields": list(updates.keys())},
        )

    return UpdateConfigResponse(
        applied=updates,
        stream_restarted=stream_restarted,
        config=_build_config_response(ctx),
    )
