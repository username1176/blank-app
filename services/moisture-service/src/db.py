"""
Database connection management.

Provides:
- An asyncpg connection pool (hot query path).
- Helper to run a lightweight ping and retrieve the TimescaleDB version
  (used by the health check).
- Dependency injector `get_db()` for FastAPI route handlers.
"""

from __future__ import annotations

import time
from typing import AsyncGenerator

import asyncpg

from src.config import get_settings
from src.logger import get_logger

log = get_logger(__name__)

# Module-level pool — created during lifespan startup, closed on shutdown.
_pool: asyncpg.Pool | None = None


async def create_pool() -> None:
    """Initialise the asyncpg connection pool.  Called once at startup."""
    global _pool  # noqa: PLW0603

    settings = get_settings()

    _pool = await asyncpg.create_pool(
        dsn=settings.db_dsn,
        min_size=settings.DB_POOL_MIN,
        max_size=settings.DB_POOL_MAX,
        command_timeout=settings.DB_COMMAND_TIMEOUT,
        # Enforce tenant GUC isolation: reset to empty string on connection checkout
        init=_init_connection,
    )

    log.info(
        "Database pool created",
        host=settings.DB_HOST,
        db=settings.DB_NAME,
        min=settings.DB_POOL_MIN,
        max=settings.DB_POOL_MAX,
    )


async def _init_connection(conn: asyncpg.Connection) -> None:
    """Run once per physical connection to set session defaults."""
    await conn.execute("SET app.current_customer_id = ''")


async def close_pool() -> None:
    """Drain and close the pool.  Called on shutdown."""
    global _pool  # noqa: PLW0603
    if _pool is not None:
        await _pool.close()
        _pool = None
        log.info("Database pool closed")


def get_pool() -> asyncpg.Pool:
    if _pool is None:
        raise RuntimeError("Database pool has not been initialised")
    return _pool


async def ping() -> tuple[int, str | None]:
    """
    Run a trivial query and return (latency_ms, timescaledb_version_or_None).
    Raises on connection failure.
    """
    pool = get_pool()
    start = time.monotonic()

    async with pool.acquire() as conn:
        await conn.fetchval("SELECT 1")
        latency_ms = round((time.monotonic() - start) * 1000)

        try:
            tsdb_version: str | None = await conn.fetchval(
                "SELECT extversion FROM pg_extension WHERE extname = 'timescaledb'"
            )
        except Exception:  # noqa: BLE001
            tsdb_version = None

    return latency_ms, tsdb_version


# ---------------------------------------------------------------------------
# FastAPI dependency
# ---------------------------------------------------------------------------

async def get_db() -> AsyncGenerator[asyncpg.Connection, None]:
    """
    Yield a checked-out connection from the pool.
    Use as a FastAPI dependency:

        async def my_route(conn: asyncpg.Connection = Depends(get_db)):
            ...
    """
    async with get_pool().acquire() as conn:
        yield conn
