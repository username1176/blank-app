"""
Model versioning — checkpoint layout, version string generation, save/load.

Checkpoint directory layout
----------------------------
{MODEL_CHECKPOINT_DIR}/
└── {customer_id}/
    └── {version}/              ← e.g. v20260330-143025-acme1234-a7f3b2
        ├── weights.pt          ← torch.save(model.state_dict(), ...)
        ├── config.json         ← ModelConfig.save()
        └── metrics.json        ← TrainingMetrics.to_dict()

The version string encodes the timestamp, a customer prefix, and a short UUID
so checkpoints are globally sortable and traceable to their tenant without
exposing the full customer UUID.

Version format:  v{YYYYmmdd}-{HHmmss}-{customer_prefix8}-{uid6}
Example:         v20260330-143025-acme1234-a7f3b2
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

import torch

from src.model.config import ModelConfig
from src.model.predictor import MoisturePredictor
from src.training.trainer import TrainingMetrics


# ---------------------------------------------------------------------------
# Version string
# ---------------------------------------------------------------------------

def generate_version(customer_id: str) -> str:
    """
    Produce a sortable, customer-scoped version identifier.

    Parameters
    ----------
    customer_id : Customer UUID (dashes stripped for the prefix segment).
    """
    now    = datetime.now(tz=timezone.utc)
    date   = now.strftime("%Y%m%d")
    time   = now.strftime("%H%M%S")
    prefix = customer_id.replace("-", "")[:8]
    uid    = uuid4().hex[:6]
    return f"v{date}-{time}-{prefix}-{uid}"


# ---------------------------------------------------------------------------
# Save checkpoint
# ---------------------------------------------------------------------------

def save_checkpoint(
    model:       MoisturePredictor,
    model_config: ModelConfig,
    metrics:     TrainingMetrics,
    base_dir:    str | Path,
    customer_id: str,
    version:     str,
) -> Path:
    """
    Persist a fine-tuned checkpoint to disk.

    The model config is updated with ``version`` before writing so the sidecar
    config.json always reflects the checkpoint it lives alongside.

    Parameters
    ----------
    model        : Fine-tuned model with best weights already loaded.
    model_config : Architecture config (will be mutated: version field updated).
    metrics      : Training metrics to record alongside the weights.
    base_dir     : Root directory for all checkpoints.
    customer_id  : Used to namespace the checkpoint under a per-customer folder.
    version      : Version string from ``generate_version()``.

    Returns
    -------
    checkpoint_dir : The directory that was created.
    """
    checkpoint_dir = Path(base_dir) / customer_id / version
    checkpoint_dir.mkdir(parents=True, exist_ok=True)

    # ── Weights ───────────────────────────────────────────────────────────────
    torch.save(model.state_dict(), checkpoint_dir / "weights.pt")

    # ── Config (update version to match this checkpoint) ──────────────────────
    import dataclasses  # noqa: PLC0415
    updated_config = dataclasses.replace(model_config, version=version)
    updated_config.save(checkpoint_dir / "config.json")

    # ── Metrics ───────────────────────────────────────────────────────────────
    with open(checkpoint_dir / "metrics.json", "w") as fh:
        json.dump(metrics.to_dict(), fh, indent=2, default=str)

    return checkpoint_dir


# ---------------------------------------------------------------------------
# List available checkpoints
# ---------------------------------------------------------------------------

def list_checkpoints(
    base_dir: str | Path,
    customer_id: str,
) -> list[dict[str, str]]:
    """
    Return metadata for all checkpoints belonging to a customer, newest first.

    Each entry: { version, path, created_at (from config.json) }
    """
    customer_dir = Path(base_dir) / customer_id
    if not customer_dir.exists():
        return []

    results: list[dict[str, str]] = []
    for version_dir in sorted(customer_dir.iterdir(), reverse=True):
        if not version_dir.is_dir():
            continue
        config_path = version_dir / "config.json"
        entry: dict[str, str] = {
            "version": version_dir.name,
            "path":    str(version_dir),
        }
        if config_path.exists():
            try:
                cfg = ModelConfig.load(config_path)
                entry["model_version"] = cfg.version
            except Exception:  # noqa: BLE001
                pass
        results.append(entry)

    return results
