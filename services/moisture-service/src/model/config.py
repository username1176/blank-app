"""
ModelConfig — hyperparameters for the moisture prediction model.

Saved as a JSON sidecar alongside model weights so each checkpoint is
self-describing.  Loading a checkpoint always restores the exact architecture
that produced it.
"""

from __future__ import annotations

import dataclasses
import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal


@dataclass
class ModelConfig:
    # ── Thermal image encoder ─────────────────────────────────────────────────
    # Channels in the thermal image tensor (1 = grayscale IR, 3 = pseudo-colour).
    thermal_in_channels: int = 1
    # ResNet variant used as the CNN backbone.
    thermal_backbone: Literal["resnet18", "resnet34", "resnet50"] = "resnet18"
    # Load ImageNet pretrained weights and adapt to thermal_in_channels.
    thermal_pretrained: bool = True
    # Dimensionality of the linear projection on top of the backbone pool.
    thermal_feature_dim: int = 256

    # ── Sensor LSTM ───────────────────────────────────────────────────────────
    # Number of features in each sensor reading timestep:
    #   temperature_c, relative_humidity_pct, atmospheric_pressure_hpa,
    #   dew_point_c, wind_speed_ms, delta_seconds  (6 default features)
    sensor_input_dim: int = 6
    # LSTM hidden state size per direction.
    sensor_hidden_dim: int = 128
    # Number of stacked LSTM layers.
    sensor_num_layers: int = 2
    # Dropout applied between LSTM layers (ignored when num_layers == 1).
    sensor_dropout: float = 0.3
    # Dimensionality of the linear projection of the final LSTM hidden state.
    sensor_feature_dim: int = 128

    # ── Fusion head ───────────────────────────────────────────────────────────
    # Hidden layer widths in the MLP that fuses thermal + sensor embeddings.
    fusion_hidden_dims: list[int] = field(default_factory=lambda: [256, 128])
    # Dropout applied after each fusion hidden layer.
    fusion_dropout: float = 0.3

    # ── Output ────────────────────────────────────────────────────────────────
    # When True the model predicts both a mean and a log-variance (aleatoric
    # uncertainty estimation).  When False only the mean is produced.
    output_uncertainty: bool = True

    # ── Metadata ──────────────────────────────────────────────────────────────
    # Human-readable version tag stored in the checkpoint; not used by the model.
    version: str = "0.1.0"

    # ── Derived helpers ───────────────────────────────────────────────────────

    @property
    def fusion_input_dim(self) -> int:
        """Width of the vector entering the fusion MLP."""
        return self.thermal_feature_dim + self.sensor_feature_dim

    @property
    def output_dim(self) -> int:
        """Number of scalars produced by the output head (1 or 2)."""
        return 2 if self.output_uncertainty else 1

    # ── Serialisation ─────────────────────────────────────────────────────────

    def to_dict(self) -> dict:
        return dataclasses.asdict(self)

    def save(self, path: Path | str) -> None:
        """Write config to a JSON file."""
        with open(path, "w") as fh:
            json.dump(self.to_dict(), fh, indent=2)

    @classmethod
    def load(cls, path: Path | str) -> "ModelConfig":
        """Restore config from a JSON file."""
        with open(path) as fh:
            data = json.load(fh)
        return cls(**data)
