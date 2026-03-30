"""
MoisturePredictor — end-to-end moisture percentage prediction model.

Architecture
------------
1. ThermalEncoder   : (B, C, H, W)            → (B, thermal_feature_dim)
2. SensorLSTM       : (B, T, sensor_input_dim) → (B, sensor_feature_dim)
3. Fusion MLP       : concat → LayerNorm → [Linear→ReLU→Dropout] × N
4. Output head      : Linear → (moisture_pct) or (moisture_pct, log_var)

Both encoder inputs are optional independently:
- If ``images`` is None the model uses zero-filled thermal features (sensor-only
  mode; accuracy will be lower but the service degrades gracefully).
- ``sensor_seq`` is always required.

Output
------
``ModelOutput`` named tuple with:
  moisture_pct  : (B,)  — predicted moisture in [0, 100] %.
  log_var       : (B,)  — log-variance for aleatoric uncertainty, or None
                          when ``config.output_uncertainty`` is False.
"""

from __future__ import annotations

from typing import NamedTuple

import torch
import torch.nn as nn

from src.model.config import ModelConfig
from src.model.sensor_lstm import SensorLSTM
from src.model.thermal_encoder import ThermalEncoder


# ---------------------------------------------------------------------------
# Output container
# ---------------------------------------------------------------------------

class ModelOutput(NamedTuple):
    """
    moisture_pct : Tensor (B,) — values in [0, 100].
    log_var      : Tensor (B,) or None.
                   Aleatoric uncertainty as log-variance.
                   Point estimate std = exp(log_var / 2).
                   95 % CI ≈ moisture_pct ± 1.96 × std.
    """
    moisture_pct: torch.Tensor
    log_var: torch.Tensor | None


# ---------------------------------------------------------------------------
# Fusion MLP
# ---------------------------------------------------------------------------

class _FusionHead(nn.Module):
    """MLP that fuses thermal and sensor embeddings into a single vector."""

    def __init__(self, config: ModelConfig) -> None:
        super().__init__()

        dims = [config.fusion_input_dim, *config.fusion_hidden_dims]
        layers: list[nn.Module] = [nn.LayerNorm(dims[0])]

        for in_dim, out_dim in zip(dims[:-1], dims[1:]):
            layers += [
                nn.Linear(in_dim, out_dim),
                nn.ReLU(inplace=True),
                nn.Dropout(p=config.fusion_dropout),
            ]

        self.mlp = nn.Sequential(*layers)
        self.out_dim = dims[-1]

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.mlp(x)


# ---------------------------------------------------------------------------
# Top-level model
# ---------------------------------------------------------------------------

class MoisturePredictor(nn.Module):
    """
    Full moisture prediction model combining thermal imagery and sensor history.

    Parameters
    ----------
    config : ModelConfig
        Architecture hyperparameters.
    """

    def __init__(self, config: ModelConfig) -> None:
        super().__init__()
        self.config = config

        self.thermal_encoder = ThermalEncoder(config)
        self.sensor_lstm     = SensorLSTM(config)
        self.fusion_head     = _FusionHead(config)

        # Output head — predicts (mean, log_var) or just mean
        self.output_head = nn.Linear(
            self.fusion_head.out_dim,
            config.output_dim,
        )

        self._init_output_head()

    # ── Weight initialisation ─────────────────────────────────────────────────

    def _init_output_head(self) -> None:
        """Bias the output head so the model starts near 20 % moisture."""
        nn.init.xavier_uniform_(self.output_head.weight, gain=0.1)
        with torch.no_grad():
            # logit(0.20) ≈ -1.39 on a sigmoid that maps [-∞,+∞] → [0,100]
            self.output_head.bias[0] = -1.39
            if self.config.output_uncertainty:
                # Start with near-zero log-variance → std ≈ 1 %
                self.output_head.bias[1] = 0.0

    # ── Forward ───────────────────────────────────────────────────────────────

    def forward(
        self,
        sensor_seq: torch.Tensor,
        images: torch.Tensor | None = None,
        thermal_features: torch.Tensor | None = None,
        sensor_lengths: torch.Tensor | None = None,
    ) -> ModelOutput:
        """
        Parameters
        ----------
        sensor_seq : Tensor (B, T, sensor_input_dim)
            Padded sequence of sensor readings (required).
        images : Tensor (B, C, H, W), optional
            Raw thermal images.  Mutually exclusive with ``thermal_features``.
        thermal_features : Tensor (B, thermal_feature_dim), optional
            Pre-extracted thermal feature vectors.  Use this when the
            feature extraction pipeline runs separately (e.g. edge device).
        sensor_lengths : LongTensor (B,), optional
            True lengths of ``sensor_seq`` rows.  Enables packed-sequence
            optimisation for variable-length inputs.

        Returns
        -------
        ModelOutput
        """
        B = sensor_seq.size(0)
        device = sensor_seq.device

        # ── Thermal branch ────────────────────────────────────────────────────
        if images is not None and thermal_features is not None:
            raise ValueError(
                "Provide either 'images' or 'thermal_features', not both."
            )

        if images is not None:
            t_feat = self.thermal_encoder(images)           # (B, thermal_feature_dim)
        elif thermal_features is not None:
            t_feat = thermal_features                       # already extracted
        else:
            # Sensor-only mode: zero-fill the thermal slot so the fusion MLP
            # still receives correctly-shaped input.
            t_feat = torch.zeros(
                B, self.config.thermal_feature_dim, device=device
            )

        # ── Sensor branch ─────────────────────────────────────────────────────
        s_feat = self.sensor_lstm(sensor_seq, lengths=sensor_lengths)  # (B, sensor_feature_dim)

        # ── Fusion ────────────────────────────────────────────────────────────
        fused = torch.cat([t_feat, s_feat], dim=-1)        # (B, fusion_input_dim)
        fused = self.fusion_head(fused)                    # (B, fusion_hidden_dims[-1])

        # ── Output head ───────────────────────────────────────────────────────
        out = self.output_head(fused)                      # (B, 1 or 2)

        # Moisture percentage: sigmoid maps (-∞, +∞) → (0, 1), scale to (0, 100)
        moisture_pct = torch.sigmoid(out[:, 0]) * 100.0    # (B,)

        log_var: torch.Tensor | None = None
        if self.config.output_uncertainty:
            # Clamp log-variance to [-10, 10] for numerical stability.
            log_var = torch.clamp(out[:, 1], min=-10.0, max=10.0)

        return ModelOutput(moisture_pct=moisture_pct, log_var=log_var)

    # ── Convenience methods ───────────────────────────────────────────────────

    def predict_with_ci(
        self,
        sensor_seq: torch.Tensor,
        images: torch.Tensor | None = None,
        thermal_features: torch.Tensor | None = None,
        sensor_lengths: torch.Tensor | None = None,
        z: float = 1.96,
    ) -> dict[str, torch.Tensor]:
        """
        Run forward and compute a z-score confidence interval.

        Returns a dict with keys:
          ``moisture_pct``, ``std``, ``lower``, ``upper``
        where lower/upper are the (z × std) confidence bounds clamped to [0, 100].
        """
        out = self.forward(
            sensor_seq=sensor_seq,
            images=images,
            thermal_features=thermal_features,
            sensor_lengths=sensor_lengths,
        )

        result: dict[str, torch.Tensor] = {"moisture_pct": out.moisture_pct}

        if out.log_var is not None:
            std = torch.exp(out.log_var / 2.0)
            result["std"]   = std
            result["lower"] = torch.clamp(out.moisture_pct - z * std, 0.0, 100.0)
            result["upper"] = torch.clamp(out.moisture_pct + z * std, 0.0, 100.0)
        else:
            zeros = torch.zeros_like(out.moisture_pct)
            result["std"]   = zeros
            result["lower"] = out.moisture_pct
            result["upper"] = out.moisture_pct

        return result

    def count_parameters(self) -> int:
        """Total number of trainable parameters."""
        return sum(p.numel() for p in self.parameters() if p.requires_grad)
