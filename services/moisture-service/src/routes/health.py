"""
Health check endpoints.

GET /health        — full dependency check; 200 ok / 503 degraded
GET /health/live   — liveness probe (no dependency checks)
GET /health/ready  — readiness probe (database only)
"""

from __future__ import annotations

import time
from typing import Literal

from fastapi import APIRouter
from pydantic import BaseModel

from src.db import ping
from src.logger import get_logger

log = get_logger(__name__)
router = APIRouter(tags=["health"])

_start_time = time.time()


# ---------------------------------------------------------------------------
# Response models
# ---------------------------------------------------------------------------

class DatabaseCheck(BaseModel):
    status: Literal["ok", "error"]
    latency_ms: int | None = None
    timescaledb: str | None = None
    error: str | None = None


class ModelCheck(BaseModel):
    status: Literal["ok", "not_loaded"]
    device: str | None = None


class HealthChecks(BaseModel):
    database: DatabaseCheck
    model: ModelCheck


class HealthResponse(BaseModel):
    status: Literal["ok", "degraded"]
    uptime_seconds: float
    timestamp: str
    checks: HealthChecks


class LiveResponse(BaseModel):
    status: Literal["ok"]


class ReadyResponse(BaseModel):
    status: Literal["ok", "not_ready"]
    reason: str | None = None


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _uptime() -> float:
    return round(time.time() - _start_time, 2)


def _now_iso() -> str:
    from datetime import datetime, timezone
    return datetime.now(tz=timezone.utc).isoformat()


def _model_check() -> ModelCheck:
    """
    Report whether the PyTorch model is loaded.
    The model registry is imported lazily so this file has no hard
    dependency on torch at import time.
    """
    try:
        from src.model import model_registry  # noqa: PLC0415
        if model_registry.is_loaded():
            return ModelCheck(status="ok", device=model_registry.device)
        return ModelCheck(status="not_loaded")
    except ImportError:
        return ModelCheck(status="not_loaded")


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@router.get(
    "/health",
    response_model=HealthResponse,
    summary="Full health check",
    description=(
        "Returns HTTP 200 when all dependencies are healthy, "
        "HTTP 503 when any required dependency is unreachable."
    ),
)
async def health() -> HealthResponse:
    db_ok = False
    db_check: DatabaseCheck

    try:
        latency_ms, tsdb_version = await ping()
        db_check = DatabaseCheck(
            status="ok",
            latency_ms=latency_ms,
            timescaledb=tsdb_version,
        )
        db_ok = True
    except Exception as exc:  # noqa: BLE001
        msg = str(exc)
        log.warning("Health check: database unreachable", error=msg)
        db_check = DatabaseCheck(status="error", error=msg)

    model_check = _model_check()
    healthy = db_ok

    from fastapi.responses import JSONResponse  # noqa: PLC0415
    body = HealthResponse(
        status="ok" if healthy else "degraded",
        uptime_seconds=_uptime(),
        timestamp=_now_iso(),
        checks=HealthChecks(database=db_check, model=model_check),
    )

    if not healthy:
        # FastAPI will serialise the model; return 503 manually
        from fastapi import Response  # noqa: PLC0415
        return JSONResponse(status_code=503, content=body.model_dump())  # type: ignore[return-value]

    return body


@router.get(
    "/health/live",
    response_model=LiveResponse,
    summary="Liveness probe",
    description="Lightweight probe for Kubernetes — no dependency checks.",
)
async def liveness() -> LiveResponse:
    return LiveResponse(status="ok")


@router.get(
    "/health/ready",
    response_model=ReadyResponse,
    summary="Readiness probe",
    description="Signals that the service is ready to receive traffic.",
)
async def readiness() -> ReadyResponse:
    try:
        await ping()
        return ReadyResponse(status="ok")
    except Exception as exc:  # noqa: BLE001
        log.warning("Readiness check failed", error=str(exc))
        from fastapi.responses import JSONResponse  # noqa: PLC0415
        body = ReadyResponse(status="not_ready", reason="database_unreachable")
        return JSONResponse(status_code=503, content=body.model_dump())  # type: ignore[return-value]
