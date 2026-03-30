"""
SensorLSTM — recurrent encoder for time-series sensor readings.

Architecture
------------
Input      : sequence of sensor feature vectors, shape (B, T, sensor_input_dim).
             Each timestep typically carries:
               [temperature_c, relative_humidity_pct, atmospheric_pressure_hpa,
                dew_point_c, wind_speed_ms, delta_seconds]
LSTM       : num_layers stacked layers, optional inter-layer dropout.
Aggregation: last hidden state of the top layer, shape (B, sensor_hidden_dim).
Projector  : Linear → LayerNorm → ReLU → output (B, sensor_feature_dim).

Variable-length sequences are handled transparently when ``lengths`` is
supplied: the input is packed before the LSTM and unpacked after, so no
padding tokens influence the gradient.
"""

from __future__ import annotations

import torch
import torch.nn as nn
from torch.nn.utils.rnn import pack_padded_sequence, pad_packed_sequence

from src.model.config import ModelConfig


class SensorLSTM(nn.Module):
    """
    Encodes a padded batch of sensor time-series into a fixed-length vector.

    Parameters
    ----------
    config : ModelConfig
    """

    def __init__(self, config: ModelConfig) -> None:
        super().__init__()

        self.hidden_dim  = config.sensor_hidden_dim
        self.num_layers  = config.sensor_num_layers
        self.out_dim     = config.sensor_feature_dim

        # ── Input normalisation ───────────────────────────────────────────────
        # Layer-norm across the feature axis so the LSTM sees zero-mean,
        # unit-variance inputs regardless of the physical units of each sensor.
        self.input_norm = nn.LayerNorm(config.sensor_input_dim)

        # ── LSTM ──────────────────────────────────────────────────────────────
        self.lstm = nn.LSTM(
            input_size=config.sensor_input_dim,
            hidden_size=config.sensor_hidden_dim,
            num_layers=config.sensor_num_layers,
            batch_first=True,
            dropout=config.sensor_dropout if config.sensor_num_layers > 1 else 0.0,
            bidirectional=False,
        )

        # ── Projection ────────────────────────────────────────────────────────
        self.projector = nn.Sequential(
            nn.Linear(config.sensor_hidden_dim, config.sensor_feature_dim),
            nn.LayerNorm(config.sensor_feature_dim),
            nn.ReLU(inplace=True),
        )

    # ── Forward ───────────────────────────────────────────────────────────────

    def forward(
        self,
        sensor_seq: torch.Tensor,
        lengths: torch.Tensor | None = None,
    ) -> torch.Tensor:
        """
        Parameters
        ----------
        sensor_seq : Tensor, shape (B, T, sensor_input_dim)
            Padded sensor reading sequences (float32).
        lengths : LongTensor, shape (B,), optional
            True sequence length for each item in the batch.  When omitted
            all sequences are assumed to be full length (no padding).

        Returns
        -------
        features : Tensor, shape (B, sensor_feature_dim)
        """
        # Normalise each feature dimension independently.
        x = self.input_norm(sensor_seq)         # (B, T, sensor_input_dim)

        if lengths is not None:
            # Pack → LSTM → unpack to ignore padding positions.
            packed = pack_padded_sequence(
                x,
                lengths.cpu(),
                batch_first=True,
                enforce_sorted=False,
            )
            _, (h_n, _) = self.lstm(packed)
        else:
            _, (h_n, _) = self.lstm(x)

        # h_n : (num_layers, B, hidden_dim) — take the top layer.
        last_hidden = h_n[-1]                   # (B, hidden_dim)

        return self.projector(last_hidden)       # (B, sensor_feature_dim)

    # ── Helper: zero initial state ────────────────────────────────────────────

    def init_hidden(
        self,
        batch_size: int,
        device: torch.device,
    ) -> tuple[torch.Tensor, torch.Tensor]:
        """Return zero-initialised (h_0, c_0) for manual hidden state management."""
        shape = (self.num_layers, batch_size, self.hidden_dim)
        return (
            torch.zeros(*shape, device=device),
            torch.zeros(*shape, device=device),
        )
