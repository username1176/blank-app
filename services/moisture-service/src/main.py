"""
moisture-service — FastAPI application factory.

Responsibilities:
- Configure structured logging.
- Manage the asyncpg connection pool lifecycle (startup / shutdown).
- Load the PyTorch moisture model (when MODEL_PATH is set).
- Register routers.
- Expose OpenAPI docs in non-production environments.
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from typing import AsyncGenerator

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from src.config import get_settings
from src.db import close_pool, create_pool
from src.logger import configure_logging, get_logger
from src.routes.health import router as health_router

log = get_logger(__name__)


# ---------------------------------------------------------------------------
# Lifespan (replaces deprecated @app.on_event)
# ---------------------------------------------------------------------------

@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:  # noqa: ARG001
    """Startup → yield → shutdown."""
    settings = get_settings()

    # ── Startup ───────────────────────────────────────────────────────────────
    configure_logging()
    log.info(
        "moisture-service starting",
        env=settings.ENVIRONMENT,
        port=settings.PORT,
    )

    await create_pool()

    # Load ML model if a path is configured
    if settings.MODEL_PATH:
        try:
            from src.model import model_registry  # noqa: PLC0415
            model_registry.load(
                path=settings.MODEL_PATH,
                input_size=settings.MODEL_INPUT_SIZE,
                num_threads=settings.TORCH_NUM_THREADS,
            )
            log.info("Moisture model loaded", path=settings.MODEL_PATH, device=model_registry.device)
        except Exception as exc:  # noqa: BLE001
            # Non-fatal: service can still serve health checks and DB routes.
            log.warning("Failed to load moisture model — inference disabled", error=str(exc))
    else:
        log.info("MODEL_PATH not set — model loading skipped")

    yield

    # ── Shutdown ──────────────────────────────────────────────────────────────
    log.info("moisture-service shutting down")
    await close_pool()
    log.info("Shutdown complete")


# ---------------------------------------------------------------------------
# Application factory
# ---------------------------------------------------------------------------

def create_app() -> FastAPI:
    settings = get_settings()

    app = FastAPI(
        title="moisture-service",
        description=(
            "Real-time bulk materials moisture detection via camera imagery. "
            "Processes images through a PyTorch CNN and writes readings to "
            "TimescaleDB."
        ),
        version="0.1.0",
        # Hide docs in production to avoid leaking schema details
        docs_url=None if settings.is_production else "/docs",
        redoc_url=None if settings.is_production else "/redoc",
        openapi_url=None if settings.is_production else "/openapi.json",
        lifespan=lifespan,
    )

    # ── Global exception handler ──────────────────────────────────────────────
    @app.exception_handler(Exception)
    async def unhandled_exception_handler(
        request: Request, exc: Exception
    ) -> JSONResponse:
        log.error(
            "Unhandled exception",
            method=request.method,
            path=request.url.path,
            error=str(exc),
            exc_info=True,
        )
        return JSONResponse(
            status_code=500,
            content={"error": {"code": "INTERNAL_ERROR", "message": "An unexpected error occurred"}},
        )

    # ── Routers ───────────────────────────────────────────────────────────────
    app.include_router(health_router)

    return app


# Module-level app instance (used by uvicorn in the CMD below)
app = create_app()
