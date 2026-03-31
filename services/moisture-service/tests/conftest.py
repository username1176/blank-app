"""
Pytest configuration and shared fixtures for moisture-service tests.

The app is imported with MODEL_PATH='' so the service starts in stub mode
(no model file required), allowing fast unit/integration tests in CI without
GPU hardware or large model weights.
"""
from __future__ import annotations

import os

import pytest
from httpx import ASGITransport, AsyncClient

# Set required env vars before importing the app module so pydantic-settings
# validates successfully during test collection.
os.environ.setdefault("DB_NAME", "test_db")
os.environ.setdefault("DB_USER", "test")
os.environ.setdefault("DB_PASSWORD", "test")
os.environ.setdefault("JWT_SECRET", "test-jwt-secret-must-be-at-least-32-chars!")
os.environ.setdefault("MODEL_PATH", "")   # stub mode — no weights loaded


@pytest.fixture
async def client() -> AsyncClient:
    """Async HTTP client wired directly to the FastAPI ASGI app."""
    from src.main import app  # import after env vars are set

    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://test",
    ) as ac:
        yield ac
