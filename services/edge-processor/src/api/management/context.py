"""
ManagementContext — shared state for all management route handlers.

Stored on `app.state.ctx` at startup so every request can reach it via
`request.app.state.ctx`.  All fields are set once at startup and treated
as immutable references (the *objects* they point to are mutable, but the
references themselves don't change).
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Optional

if TYPE_CHECKING:
    from ...buffer.store import BufferStore
    from ...buffer.syncer import BufferSyncer
    from ...capture.manager import StreamManager
    from ...config.settings import Settings
    from ...config.store import ConfigStore
    from ...processing.pipeline import ProcessingPipeline
    from ...scheduler.runner import IntervalRunner
    from ...api.client import ApiClient
    from ...api.uploader import Uploader


@dataclass
class ManagementContext:
    settings:         "Settings"
    runner:           "IntervalRunner"
    stream_manager:   "StreamManager"
    pipeline:         "ProcessingPipeline"
    moisture_client:  "ApiClient"
    inventory_client: "ApiClient"
    uploader:         "Uploader"
    buffer:           Optional["BufferStore"]
    syncer:           Optional["BufferSyncer"]
    config_store:     "ConfigStore"
    start_time:       float = field(default_factory=time.monotonic)


def get_ctx(request) -> ManagementContext:  # type: ignore[type-arg]
    """FastAPI dependency — returns the context from app.state."""
    return request.app.state.ctx
