"""
ThermalEncoder — CNN feature extractor for thermal imagery.

Architecture
------------
Backbone : torchvision ResNet (18 / 34 / 50), first conv adapted to accept
           an arbitrary number of input channels (typically 1 for grayscale IR).
           When using pretrained weights the adaptation averages the pretrained
           RGB channel weights along the channel axis, preserving as much prior
           knowledge as possible.
Pooler   : Global average pool (already part of ResNet) → (B, backbone_dim).
Projector: Linear → BatchNorm1d → ReLU → Linear → L2-normalise
           output dim = thermal_feature_dim.

The encoder can operate in two modes:
  - ``extract(images)``  — full forward pass, returns feature vectors.
  - ``forward(images)``  — alias, used when embedded in MoisturePredictor.
"""

from __future__ import annotations

import torch
import torch.nn as nn
from torchvision import models
from torchvision.models import (
    ResNet18_Weights,
    ResNet34_Weights,
    ResNet50_Weights,
)

from src.model.config import ModelConfig

# Map backbone name → (constructor, weights enum, pool output dim)
_BACKBONES: dict[str, tuple] = {
    "resnet18": (models.resnet18, ResNet18_Weights.DEFAULT, 512),
    "resnet34": (models.resnet34, ResNet34_Weights.DEFAULT, 512),
    "resnet50": (models.resnet50, ResNet50_Weights.DEFAULT, 2048),
}


class ThermalEncoder(nn.Module):
    """
    Extracts a fixed-length feature vector from a batch of thermal images.

    Parameters
    ----------
    config : ModelConfig
        Determines backbone variant, pretrained init, input channels, and
        the output feature dimensionality.
    """

    def __init__(self, config: ModelConfig) -> None:
        super().__init__()

        if config.thermal_backbone not in _BACKBONES:
            raise ValueError(
                f"Unknown backbone '{config.thermal_backbone}'. "
                f"Choose from {list(_BACKBONES)}."
            )

        constructor, weights, backbone_out_dim = _BACKBONES[config.thermal_backbone]

        # ── Backbone ─────────────────────────────────────────────────────────
        backbone: models.ResNet = constructor(
            weights=weights if config.thermal_pretrained else None
        )

        # Adapt first convolution to the actual number of input channels.
        if config.thermal_in_channels != 3:
            backbone.conv1 = self._adapt_first_conv(
                original_conv=backbone.conv1,
                in_channels=config.thermal_in_channels,
                pretrained=config.thermal_pretrained,
            )

        # Drop the classification head — keep everything up to avgpool.
        self.backbone = nn.Sequential(
            backbone.conv1,
            backbone.bn1,
            backbone.relu,
            backbone.maxpool,
            backbone.layer1,
            backbone.layer2,
            backbone.layer3,
            backbone.layer4,
            backbone.avgpool,           # → (B, backbone_out_dim, 1, 1)
        )

        # ── Projection head ───────────────────────────────────────────────────
        # Two-layer MLP with BN in between to project to thermal_feature_dim.
        mid_dim = max(config.thermal_feature_dim * 2, backbone_out_dim // 2)
        self.projector = nn.Sequential(
            nn.Linear(backbone_out_dim, mid_dim),
            nn.BatchNorm1d(mid_dim),
            nn.ReLU(inplace=True),
            nn.Linear(mid_dim, config.thermal_feature_dim),
        )

        self.out_dim = config.thermal_feature_dim

    # ── Forward ───────────────────────────────────────────────────────────────

    def forward(self, images: torch.Tensor) -> torch.Tensor:
        """
        Parameters
        ----------
        images : Tensor, shape (B, C, H, W)
            Batch of thermal images, normalised to [0, 1] or standardised.

        Returns
        -------
        features : Tensor, shape (B, thermal_feature_dim)
            L2-normalised feature vectors.
        """
        x = self.backbone(images)               # (B, backbone_dim, 1, 1)
        x = torch.flatten(x, start_dim=1)       # (B, backbone_dim)
        x = self.projector(x)                   # (B, thermal_feature_dim)
        x = nn.functional.normalize(x, dim=-1)  # L2 normalise
        return x

    # ── Private helpers ───────────────────────────────────────────────────────

    @staticmethod
    def _adapt_first_conv(
        original_conv: nn.Conv2d,
        in_channels: int,
        pretrained: bool,
    ) -> nn.Conv2d:
        """
        Return a new Conv2d whose ``in_channels`` matches the requested value.

        When ``pretrained=True`` the weights are initialised by averaging the
        pretrained RGB channel weights along the channel axis (fan-in mean),
        which preserves learned edge detectors.  For in_channels > 3 the
        averaged weights are tiled to fill the extra channels.
        """
        new_conv = nn.Conv2d(
            in_channels,
            original_conv.out_channels,
            kernel_size=original_conv.kernel_size,
            stride=original_conv.stride,
            padding=original_conv.padding,
            bias=original_conv.bias is not None,
        )

        if pretrained:
            with torch.no_grad():
                # (out_ch, 3, kH, kW) → mean over RGB → (out_ch, 1, kH, kW)
                avg_weight = original_conv.weight.mean(dim=1, keepdim=True)
                # Tile to fill in_channels (handles both < 3 and > 3 cases)
                tiled = avg_weight.repeat(1, in_channels, 1, 1)
                new_conv.weight.copy_(tiled)
                if original_conv.bias is not None and new_conv.bias is not None:
                    new_conv.bias.copy_(original_conv.bias)

        return new_conv
