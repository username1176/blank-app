"""
Persistent runtime-config overrides store.

Settings loaded from environment variables are immutable at process start.
When operators use PUT /update-config to change values at runtime, we need
those changes to survive a container restart — they're written here.

On startup, `main.py` calls `ConfigStore.load()` and applies the returned
dict as attribute overrides on the `Settings` object (overrides win over
the original env-var values).

File format: plain JSON, one top-level object.  The file is written
atomically (write to `.tmp`, then `rename()`) to avoid corruption from an
interrupted write.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)


class ConfigStore:
    """Atomic JSON store for persisting runtime setting overrides."""

    def __init__(self, path: str) -> None:
        self._path = Path(path)

    def load(self) -> dict[str, Any]:
        """Return stored overrides, or an empty dict if the file is absent/invalid."""
        if not self._path.exists():
            return {}
        try:
            overrides = json.loads(self._path.read_text(encoding="utf-8"))
            if not isinstance(overrides, dict):
                raise ValueError("Top-level JSON value must be an object")
            logger.info(
                "Config overrides loaded",
                extra={"path": str(self._path), "keys": list(overrides.keys())},
            )
            return overrides
        except Exception as exc:
            logger.warning(
                "Failed to load config overrides — using defaults",
                extra={"path": str(self._path), "error": str(exc)},
            )
            return {}

    def save(self, overrides: dict[str, Any]) -> None:
        """
        Atomically persist *overrides*.

        Writes to a `.tmp` sibling file first, then renames to the final
        path so the file is never in a partially-written state.
        """
        self._path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self._path.with_suffix(".json.tmp")
        try:
            tmp.write_text(
                json.dumps(overrides, indent=2, default=str),
                encoding="utf-8",
            )
            tmp.replace(self._path)
            logger.debug(
                "Config overrides saved",
                extra={"path": str(self._path), "keys": list(overrides.keys())},
            )
        except Exception as exc:
            tmp.unlink(missing_ok=True)
            logger.error(
                "Failed to write config overrides",
                extra={"path": str(self._path), "error": str(exc)},
            )
            raise

    def merge(self, updates: dict[str, Any]) -> None:
        """Merge *updates* into the existing overrides and save."""
        current = self.load()
        current.update(updates)
        self.save(current)

    def remove_keys(self, keys: list[str]) -> None:
        """Remove specific keys from the overrides (e.g. to revert to env default)."""
        current = self.load()
        for k in keys:
            current.pop(k, None)
        self.save(current)
