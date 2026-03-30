"""
Management API FastAPI application factory.

Creates a FastAPI app pre-configured with:
  - Structured JSON error responses
  - API key authentication on all routes (see auth.py)
  - OpenAPI docs disabled by default (enable with MGMT_API_DOCS=true)
  - The ManagementContext stored on app.state so route handlers can reach it

Usage (from main.py):
    from .api.management.server import create_management_app
    app = create_management_app(ctx)
    # then run with uvicorn.Server(uvicorn.Config(app, host=..., port=...))
"""

from __future__ import annotations

import logging
import os
from typing import Any

from fastapi import FastAPI, Request, status
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from .context import ManagementContext
from .routes.calibrate import router as calibrate_router
from .routes.config import router as config_router
from .routes.status import router as status_router

logger = logging.getLogger(__name__)

# Enable Swagger UI / ReDoc only when explicitly requested (default off for
# production deployments — reduces attack surface and avoids leaking schema)
_DOCS_URL = "/docs"   if os.getenv("MGMT_API_DOCS", "false").lower() == "true" else None
_REDOC_URL = "/redoc" if os.getenv("MGMT_API_DOCS", "false").lower() == "true" else None


def create_management_app(ctx: ManagementContext) -> FastAPI:
    """
    Build and return the FastAPI management application.

    The `ctx` is stored on `app.state.ctx` — route handlers retrieve it
    via `request.app.state.ctx`.
    """
    app = FastAPI(
        title="Edge Processor — Management API",
        description=(
            "Local REST API for remote management of the edge processor. "
            "All endpoints require an `X-API-Key` header."
        ),
        version="1.0.0",
        docs_url=_DOCS_URL,
        redoc_url=_REDOC_URL,
        openapi_url="/openapi.json" if _DOCS_URL else None,
    )

    # ── Attach context ────────────────────────────────────────────────────────
    app.state.ctx = ctx

    # ── Error handlers ────────────────────────────────────────────────────────

    @app.exception_handler(RequestValidationError)
    async def _validation_error(
        request: Request, exc: RequestValidationError
    ) -> JSONResponse:
        return JSONResponse(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            content={
                "error": {
                    "code":    "VALIDATION_ERROR",
                    "message": "Request validation failed",
                    "detail":  exc.errors(),
                }
            },
        )

    @app.exception_handler(Exception)
    async def _unhandled_error(request: Request, exc: Exception) -> JSONResponse:
        logger.exception(
            "Unhandled error in management API",
            extra={"path": request.url.path},
        )
        return JSONResponse(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            content={
                "error": {
                    "code":    "INTERNAL_ERROR",
                    "message": "An internal error occurred",
                }
            },
        )

    # ── Routes ────────────────────────────────────────────────────────────────
    app.include_router(status_router,    tags=["Status"])
    app.include_router(calibrate_router, tags=["Calibrate"])
    app.include_router(config_router,    tags=["Config"])

    # ── Root / liveness ───────────────────────────────────────────────────────
    @app.get(
        "/",
        include_in_schema=False,
        # No auth on the root — acts as a liveness probe for the management server itself
    )
    async def _root() -> dict[str, Any]:
        return {"service": "edge-processor-mgmt", "status": "ok"}

    logger.info(
        "Management API app created",
        extra={
            "docs":  _DOCS_URL is not None,
            "host":  ctx.settings.mgmt_api_host,
            "port":  ctx.settings.mgmt_api_port,
        },
    )
    return app
