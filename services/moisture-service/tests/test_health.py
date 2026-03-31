"""
Smoke tests for the /health endpoints.

These run in CI without a database or model file — they just verify the
FastAPI application boots and the health routes respond correctly.
"""
from __future__ import annotations

import pytest
from httpx import AsyncClient


@pytest.mark.asyncio
async def test_liveness(client: AsyncClient) -> None:
    response = await client.get("/health/live")
    assert response.status_code == 200
    body = response.json()
    assert body.get("status") == "ok"


@pytest.mark.asyncio
async def test_readiness_returns_json(client: AsyncClient) -> None:
    # In stub mode the service may report degraded/not-ready (no DB),
    # but the endpoint itself must return a valid JSON response.
    response = await client.get("/health/ready")
    assert response.status_code in (200, 503)
    body = response.json()
    assert "status" in body
