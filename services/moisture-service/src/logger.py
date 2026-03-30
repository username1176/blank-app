"""
Structured logging via structlog.

In development: human-friendly coloured console output.
In production:  JSON lines (one JSON object per log record) suitable for
                log aggregation pipelines (Datadog, Loki, CloudWatch …).

Usage:
    from src.logger import get_logger
    log = get_logger(__name__)
    log.info("thing happened", pile_id=pile_id, moisture_pct=12.4)
"""

from __future__ import annotations

import logging
import sys

import structlog

from src.config import get_settings


def configure_logging() -> None:
    """Call once at startup (inside the lifespan function in main.py)."""
    settings = get_settings()

    shared_processors: list[structlog.types.Processor] = [
        structlog.contextvars.merge_contextvars,
        structlog.stdlib.add_logger_name,
        structlog.stdlib.add_log_level,
        structlog.processors.TimeStamper(fmt="iso"),
        structlog.processors.StackInfoRenderer(),
    ]

    if settings.is_production:
        # JSON output — no colours, machine-readable
        processors: list[structlog.types.Processor] = [
            *shared_processors,
            structlog.processors.dict_tracebacks,
            structlog.processors.JSONRenderer(),
        ]
    else:
        # Pretty console output for local development
        processors = [
            *shared_processors,
            structlog.dev.ConsoleRenderer(colors=True),
        ]

    structlog.configure(
        processors=processors,
        wrapper_class=structlog.stdlib.BoundLogger,
        context_class=dict,
        logger_factory=structlog.stdlib.LoggerFactory(),
        cache_logger_on_first_use=True,
    )

    # Keep stdlib logging in sync so uvicorn access logs go through structlog
    log_level = getattr(logging, settings.LOG_LEVEL.upper(), logging.INFO)
    logging.basicConfig(
        format="%(message)s",
        stream=sys.stdout,
        level=log_level,
    )
    for noisy in ("uvicorn.access", "uvicorn.error"):
        logging.getLogger(noisy).setLevel(log_level)


def get_logger(name: str) -> structlog.stdlib.BoundLogger:
    return structlog.get_logger(name)
