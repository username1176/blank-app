"""
Application settings loaded from environment variables / .env file.

All fields have documented defaults so the service starts in a safe,
noop-friendly state — missing credentials disable the relevant feature
rather than crashing at startup.
"""

from __future__ import annotations

import re
from typing import Optional, Tuple

from pydantic import Field, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


def _parse_hsv(value: str) -> Tuple[int, int, int]:
    """Parse 'H,S,V' string into a (H,S,V) int tuple."""
    parts = [p.strip() for p in value.split(",")]
    if len(parts) != 3:
        raise ValueError(f"Expected 'H,S,V' format, got: {value!r}")
    return (int(parts[0]), int(parts[1]), int(parts[2]))


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # ── Device / site identity ────────────────────────────────────────────────
    site_id: str = Field(..., description="UUID of the site this device monitors")
    pile_id: str = Field(..., description="UUID of the primary pile this device monitors")
    camera_id_thermal: Optional[str] = Field(
        None, description="UUID of the thermal camera (registered in inventory-service)"
    )
    camera_id_rgb: Optional[str] = Field(
        None, description="UUID of the RGB camera"
    )

    # ── Camera sources ────────────────────────────────────────────────────────
    rgb_rtsp_url: Optional[str] = Field(
        None, description="RTSP URL for the RGB camera"
    )
    thermal_rtsp_url: Optional[str] = Field(
        None, description="RTSP URL for an IP thermal camera"
    )
    # V4L2 alternative for USB thermal cameras (e.g. FLIR Lepton)
    thermal_v4l2_device: Optional[str] = Field(None, description="V4L2 device path, e.g. /dev/video1")
    thermal_v4l2_width: int = Field(160, ge=1, description="V4L2 frame width")
    thermal_v4l2_height: int = Field(120, ge=1, description="V4L2 frame height")
    thermal_v4l2_format: str = Field("GRAY16_LE", description="V4L2 pixel format")

    # ── GStreamer (Jetson hardware decode) ────────────────────────────────────
    use_gstreamer: bool = Field(
        False,
        description="Use nvv4l2decoder GStreamer pipeline (Jetson JetPack 5.x only)",
    )

    # ── Capture settings ──────────────────────────────────────────────────────
    rgb_target_fps: int = Field(5, ge=1, le=30, description="RGB stream capture FPS")
    thermal_target_fps: int = Field(5, ge=1, le=30, description="Thermal stream capture FPS")
    stream_reconnect_delay_s: float = Field(3.0, ge=0.5, description="Seconds between reconnect attempts")

    # ── Processing interval ───────────────────────────────────────────────────
    process_interval_s: float = Field(
        30.0, ge=1.0, description="How often to run the full pipeline (seconds)"
    )

    # ── Thermal calibration ───────────────────────────────────────────────────
    thermal_scale: float = Field(
        0.01,
        description="Multiplier: raw_pixel * scale + offset = Celsius. "
                    "0.01 = centi-Kelvin input; 0.04 = FLIR raw K*40; 1.0 = already Celsius",
    )
    thermal_offset: float = Field(
        -273.15,
        description="Additive offset after scaling (default -273.15 converts Kelvin to Celsius)",
    )
    thermal_min_valid_c: float = Field(-20.0, description="Clamp floor (°C)")
    thermal_max_valid_c: float = Field(120.0, description="Clamp ceiling (°C)")
    thermal_hot_spot_sigma: float = Field(
        2.0, ge=0.5, description="Pixels hotter than mean + N*std are counted as hot spots"
    )

    # ── Pile segmentation ─────────────────────────────────────────────────────
    seg_method: str = Field(
        "adaptive_threshold",
        description="adaptive_threshold | color_range | canny_edges",
    )
    seg_min_area_px: int = Field(5000, ge=100, description="Min contour pixel area for a pile")
    seg_min_frame_fraction: float = Field(
        0.02, ge=0.001, le=0.95,
        description="Pile must occupy at least this fraction of the frame",
    )
    seg_pixel_to_m2: float = Field(
        0.0005, gt=0,
        description="Real-world area per pixel (m²/px) at the installed camera height",
    )
    seg_heap_height_factor: float = Field(
        0.35, gt=0,
        description="h_estimated = factor * sqrt(footprint_m2) (dimensionless shape constant)",
    )
    # colour-range mode bounds stored as raw strings, parsed on demand
    seg_color_hsv_lower: str = Field("10,30,60", description="HSV lower bound (H,S,V)")
    seg_color_hsv_upper: str = Field("40,255,255", description="HSV upper bound (H,S,V)")

    # ── Ambient sensor defaults ───────────────────────────────────────────────
    ambient_temp_c: Optional[float] = Field(None, description="Ambient temperature (°C)")
    ambient_humidity_pct: Optional[float] = Field(
        None, ge=0.0, le=100.0, description="Relative humidity (%)"
    )
    ambient_pressure_hpa: Optional[float] = Field(
        None, ge=800.0, le=1100.0, description="Atmospheric pressure (hPa)"
    )

    # ── API ───────────────────────────────────────────────────────────────────
    moisture_api_url: str = Field("http://moisture-service:8000", description="moisture-service base URL")
    inventory_api_url: str = Field("http://inventory-service:3001", description="inventory-service base URL")
    api_jwt_token: str = Field(..., description="JWT Bearer token for API authentication")
    api_timeout_s: float = Field(30.0, ge=1.0, description="HTTP request timeout (seconds)")
    api_max_retries: int = Field(4, ge=0, le=10, description="Max retry attempts per request")
    api_retry_initial_delay_s: float = Field(1.0, ge=0.1, description="Initial retry backoff (seconds)")

    # ── Management REST API ───────────────────────────────────────────────────
    mgmt_api_enabled: bool = Field(True, description="Enable the local management REST API")
    mgmt_api_host: str = Field(
        "0.0.0.0",
        description="Bind address for the management API server. "
                    "Use 127.0.0.1 to restrict to loopback only.",
    )
    mgmt_api_port: int = Field(8080, ge=1, le=65535, description="Management API port")
    mgmt_api_key: str = Field(
        ...,
        description="Secret API key required in the X-API-Key header on every request",
    )
    config_overrides_path: str = Field(
        "/data/edge_config.json",
        description="Path to the JSON file where runtime config changes are persisted",
    )

    # ── Offline buffer ────────────────────────────────────────────────────────
    buffer_enabled: bool = Field(
        True,
        description="Enable SQLite offline buffer. When False, failed uploads are simply logged.",
    )
    buffer_db_path: str = Field(
        "/data/edge_buffer.db",
        description="Path to the SQLite buffer database file (created if absent)",
    )
    buffer_max_rows: int = Field(
        10_000,
        ge=100,
        description="Max pending rows. Oldest entries are evicted when this is exceeded.",
    )
    buffer_max_size_mb: float = Field(
        512.0,
        gt=0,
        description="Soft limit on total BLOB storage (MB). Oldest thermal JPEGs are evicted first.",
    )
    buffer_prune_done_after_h: int = Field(
        24,
        ge=1,
        description="Hours to retain synced/failed rows before pruning them",
    )

    # ── Sync policy ───────────────────────────────────────────────────────────
    sync_batch_size: int = Field(
        50,
        ge=1,
        le=500,
        description="Max buffered entries to upload in a single sync pass",
    )
    sync_max_attempts: int = Field(
        5,
        ge=1,
        description="After this many failures an entry is permanently marked 'failed'",
    )
    sync_connectivity_timeout_s: float = Field(
        5.0,
        ge=0.5,
        description="Timeout for the lightweight /health/live connectivity probe (seconds)",
    )

    # ── Diagnostics ───────────────────────────────────────────────────────────
    log_level: str = Field("INFO", description="Python logging level")
    debug_frame_dir: Optional[str] = Field(
        None, description="Directory to save annotated debug frames (disabled if blank)"
    )
    debug_frame_max: int = Field(100, ge=1, description="Max debug frame files to retain")

    # ── Derived helpers ───────────────────────────────────────────────────────

    @field_validator("seg_method")
    @classmethod
    def _validate_seg_method(cls, v: str) -> str:
        allowed = {"adaptive_threshold", "color_range", "canny_edges"}
        if v not in allowed:
            raise ValueError(f"seg_method must be one of {allowed!r}, got {v!r}")
        return v

    @model_validator(mode="after")
    def _validate_cameras(self) -> "Settings":
        has_rgb = bool(self.rgb_rtsp_url)
        has_thermal = bool(self.thermal_rtsp_url) or bool(self.thermal_v4l2_device)
        if not has_rgb and not has_thermal:
            raise ValueError(
                "At least one camera source is required. "
                "Set RGB_RTSP_URL and/or THERMAL_RTSP_URL / THERMAL_V4L2_DEVICE."
            )
        return self

    def hsv_lower(self) -> Tuple[int, int, int]:
        return _parse_hsv(self.seg_color_hsv_lower)

    def hsv_upper(self) -> Tuple[int, int, int]:
        return _parse_hsv(self.seg_color_hsv_upper)

    def has_rgb(self) -> bool:
        return bool(self.rgb_rtsp_url)

    def has_thermal(self) -> bool:
        return bool(self.thermal_rtsp_url) or bool(self.thermal_v4l2_device)

    def has_ambient_sensors(self) -> bool:
        return (
            self.ambient_temp_c is not None
            and self.ambient_humidity_pct is not None
        )
