"""
Pydantic request and response models for the management API.

All response models use explicit field definitions rather than inheriting
from Settings directly — this lets us sanitise outputs (redact secrets,
rename fields) without coupling the API shape to the internal config model.
"""

from __future__ import annotations

from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, Field


# ── GET /status ───────────────────────────────────────────────────────────────

class StreamStatus(BaseModel):
    alive: bool
    fps_actual: float
    frames_captured: int
    frames_dropped: int
    reconnect_count: int
    last_error: Optional[str] = None


class RunnerStats(BaseModel):
    running: bool
    cycles_total: int
    cycles_ok: int
    cycles_failed: int
    synced_total: int
    buffered_total: int
    last_run_at: Optional[float] = None
    last_run_ms: float


class BufferStatus(BaseModel):
    pending_count: int
    syncing_count: int
    done_count: int
    failed_count: int
    total_count: int
    blob_mb: float
    oldest_pending_at: Optional[str] = None


class ConnectivityStatus(BaseModel):
    moisture_service: Optional[bool] = None   # None = not checked
    inventory_service: Optional[bool] = None


class StatusResponse(BaseModel):
    timestamp: str
    uptime_s: float
    runner: RunnerStats
    streams: Dict[str, StreamStatus]
    buffer: Optional[BufferStatus] = None
    connectivity: ConnectivityStatus


# ── POST /calibrate ───────────────────────────────────────────────────────────

class CalibrateRequest(BaseModel):
    """
    Parameters for a manual calibration run.

    upload
        When True the pipeline result is also posted to the cloud APIs
        (subject to buffering if they are unreachable).  Defaults to False
        so operators can verify detection without generating spurious data.
    """
    upload: bool = Field(
        False,
        description="POST the result to moisture/inventory services after the run",
    )


class CalibrateResponse(BaseModel):
    timestamp: str
    pile_detected: bool
    footprint_m2: float
    height_m_est: float
    volume_m3_est: float
    surface_area_m2_est: float
    segmentation_confidence: float
    has_thermal: bool
    temp_mean_c: Optional[float] = None
    temp_min_c: Optional[float] = None
    temp_max_c: Optional[float] = None
    temp_std_c: Optional[float] = None
    uniformity_index: Optional[float] = None
    hot_spot_count: Optional[int] = None
    cold_spot_count: Optional[int] = None
    gradient_mean: Optional[float] = None
    processing_ms: float
    uploaded: bool = False
    upload_buffered: bool = False
    warnings: List[str] = Field(default_factory=list)


# ── GET /config ───────────────────────────────────────────────────────────────

class ConfigResponse(BaseModel):
    # Identity
    site_id: str
    pile_id: str
    camera_id_thermal: Optional[str] = None
    camera_id_rgb: Optional[str] = None
    # Camera sources (credentials redacted from URLs by the route handler)
    rgb_rtsp_url: Optional[str] = None
    thermal_rtsp_url: Optional[str] = None
    thermal_v4l2_device: Optional[str] = None
    use_gstreamer: bool
    rgb_target_fps: int
    thermal_target_fps: int
    stream_reconnect_delay_s: float
    # Intervals
    process_interval_s: float
    # Segmentation
    seg_method: str
    seg_min_area_px: int
    seg_min_frame_fraction: float
    seg_pixel_to_m2: float
    seg_heap_height_factor: float
    seg_color_hsv_lower: str
    seg_color_hsv_upper: str
    # Thermal calibration
    thermal_scale: float
    thermal_offset: float
    thermal_min_valid_c: float
    thermal_max_valid_c: float
    thermal_hot_spot_sigma: float
    # API endpoints
    moisture_api_url: str
    inventory_api_url: str
    # Ambient sensors
    has_ambient_sensors: bool
    ambient_temp_c: Optional[float] = None
    ambient_humidity_pct: Optional[float] = None
    ambient_pressure_hpa: Optional[float] = None
    # Buffer
    buffer_enabled: bool
    buffer_max_rows: int
    buffer_max_size_mb: float
    buffer_prune_done_after_h: int
    # Sync
    sync_batch_size: int
    sync_max_attempts: int
    sync_connectivity_timeout_s: float
    # Management API (port only — key is never returned)
    mgmt_api_host: str
    mgmt_api_port: int


# ── PUT /update-config ────────────────────────────────────────────────────────

class UpdateConfigRequest(BaseModel):
    """
    Partial settings update.  All fields are optional — only supplied fields
    are applied.  Security credentials (JWT, API keys) cannot be changed via
    this endpoint; restart the container with new env vars instead.
    """

    # Camera sources — trigger stream restart when changed
    rgb_rtsp_url:         Optional[str]  = None
    thermal_rtsp_url:     Optional[str]  = None
    thermal_v4l2_device:  Optional[str]  = None
    use_gstreamer:        Optional[bool] = None
    rgb_target_fps:       Optional[int]  = Field(None, ge=1, le=30)
    thermal_target_fps:   Optional[int]  = Field(None, ge=1, le=30)
    stream_reconnect_delay_s: Optional[float] = Field(None, ge=0.5)

    # Processing — live updates, no restart needed
    process_interval_s:   Optional[float] = Field(None, ge=1.0)

    # Segmentation
    seg_method: Optional[Literal["adaptive_threshold", "color_range", "canny_edges"]] = None
    seg_min_area_px:          Optional[int]   = Field(None, ge=100)
    seg_min_frame_fraction:   Optional[float] = Field(None, ge=0.001, le=0.95)
    seg_pixel_to_m2:          Optional[float] = Field(None, gt=0)
    seg_heap_height_factor:   Optional[float] = Field(None, gt=0)
    seg_color_hsv_lower:      Optional[str]   = None   # "H,S,V"
    seg_color_hsv_upper:      Optional[str]   = None   # "H,S,V"

    # Thermal calibration
    thermal_scale:          Optional[float] = None
    thermal_offset:         Optional[float] = None
    thermal_min_valid_c:    Optional[float] = None
    thermal_max_valid_c:    Optional[float] = None
    thermal_hot_spot_sigma: Optional[float] = Field(None, ge=0.5)

    # API endpoints — live; clients pick up new URL on the next request
    moisture_api_url:  Optional[str] = None
    inventory_api_url: Optional[str] = None

    # Ambient sensor overrides
    ambient_temp_c:        Optional[float] = None
    ambient_humidity_pct:  Optional[float] = Field(None, ge=0.0, le=100.0)
    ambient_pressure_hpa:  Optional[float] = Field(None, ge=800.0, le=1100.0)

    # Sync policy
    sync_batch_size:    Optional[int]   = Field(None, ge=1, le=500)
    sync_max_attempts:  Optional[int]   = Field(None, ge=1)


class UpdateConfigResponse(BaseModel):
    applied: Dict[str, Any]          # fields that were changed and their new values
    stream_restarted: List[str]      # which streams were restarted ("rgb", "thermal")
    config: ConfigResponse           # full config after the update


# ── Shared error shape ────────────────────────────────────────────────────────

class ErrorDetail(BaseModel):
    code: str
    message: str
