"""
ModelRegistry — versioned model loading and managed inference.

A checkpoint directory is expected to contain two files:
  weights.pt   — PyTorch state dict produced by torch.save(model.state_dict(), ...)
  config.json  — ModelConfig serialised by ModelConfig.save()

The registry keeps a single active model in memory.  ``load()`` is called once
at service startup; ``predict()`` is called per request.  All public methods
are thread-safe via a reentrant lock.

Usage (startup)
---------------
    from src.model import model_registry
    model_registry.load(
        path="/checkpoints/moisture/v1.2.0",
        input_size=224,
        num_threads=4,
    )

Usage (inference)
-----------------
    result = model_registry.predict(
        sensor_seq=sensor_tensor,   # (1, T, sensor_input_dim)
        images=image_tensor,        # (1, C, H, W) — optional
    )
    print(result.moisture_pct, result.confidence)
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass
from pathlib import Path

import torch

from src.logger import get_logger
from src.model.config import ModelConfig
from src.model.predictor import ModelOutput, MoisturePredictor

log = get_logger(__name__)

# Standard filenames inside a checkpoint directory.
_WEIGHTS_FILE = "weights.pt"
_CONFIG_FILE  = "config.json"


# ---------------------------------------------------------------------------
# Inference result
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class PredictionResult:
    """
    Attributes
    ----------
    moisture_pct   : Predicted moisture percentage (0–100).
    confidence     : Normalised confidence score (0–1).  Derived from the
                     inverse of the predicted variance; clipped to [0, 1].
    std            : Standard deviation in percentage points.  None when the
                     model was not trained with uncertainty output.
    lower_bound    : Lower end of the 95 % confidence interval (moisture %).
    upper_bound    : Upper end of the 95 % confidence interval (moisture %).
    inference_ms   : Wall-clock time spent in torch inference (milliseconds).
    model_version  : Version string of the loaded checkpoint.
    """
    moisture_pct:  float
    confidence:    float
    std:           float | None
    lower_bound:   float
    upper_bound:   float
    inference_ms:  float
    model_version: str


# ---------------------------------------------------------------------------
# Loaded model state
# ---------------------------------------------------------------------------

@dataclass
class _LoadedModel:
    model:      MoisturePredictor
    config:     ModelConfig
    device:     torch.device
    path:       str
    loaded_at:  float   # epoch seconds


# ---------------------------------------------------------------------------
# Registry
# ---------------------------------------------------------------------------

class ModelRegistry:
    """
    Thread-safe store for a single active MoisturePredictor checkpoint.
    """

    def __init__(self) -> None:
        self._lock   = threading.RLock()
        self._active: _LoadedModel | None = None

    # ── Public API ────────────────────────────────────────────────────────────

    def load(
        self,
        path: str | Path,
        input_size: int = 224,
        num_threads: int = 0,
    ) -> None:
        """
        Load a checkpoint from ``path`` and make it the active model.

        Parameters
        ----------
        path         : Directory containing ``weights.pt`` and ``config.json``.
        input_size   : Expected spatial size of thermal images (pixels, square).
                       Stored for documentation; the model itself is size-agnostic
                       due to global average pooling.
        num_threads  : Number of intra-op threads for Torch CPU inference.
                       0 = let PyTorch choose (usually number of physical cores).
        """
        checkpoint_dir = Path(path)
        weights_path   = checkpoint_dir / _WEIGHTS_FILE
        config_path    = checkpoint_dir / _CONFIG_FILE

        if not weights_path.exists():
            raise FileNotFoundError(f"Weights file not found: {weights_path}")
        if not config_path.exists():
            raise FileNotFoundError(f"Config file not found: {config_path}")

        if num_threads > 0:
            torch.set_num_threads(num_threads)

        device = self._select_device()

        log.info(
            "Loading moisture model",
            path=str(checkpoint_dir),
            device=str(device),
        )

        config = ModelConfig.load(config_path)

        model = MoisturePredictor(config)
        state_dict = torch.load(weights_path, map_location=device, weights_only=True)
        model.load_state_dict(state_dict)
        model.to(device)
        model.eval()

        with self._lock:
            self._active = _LoadedModel(
                model=model,
                config=config,
                device=device,
                path=str(checkpoint_dir),
                loaded_at=time.time(),
            )

        log.info(
            "Moisture model ready",
            version=config.version,
            backbone=config.thermal_backbone,
            parameters=f"{model.count_parameters():,}",
            device=str(device),
        )

    def unload(self) -> None:
        """Release the loaded model and free GPU/CPU memory."""
        with self._lock:
            if self._active is not None:
                del self._active.model
                self._active = None
                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
                log.info("Moisture model unloaded")

    def reload(self) -> None:
        """Reload the currently active checkpoint from disk (picks up new weights)."""
        with self._lock:
            if self._active is None:
                raise RuntimeError("No model is currently loaded; call load() first.")
            path = self._active.path
        self.load(path)

    def is_loaded(self) -> bool:
        with self._lock:
            return self._active is not None

    @property
    def device(self) -> str:
        with self._lock:
            if self._active is None:
                return "none"
            return str(self._active.device)

    @property
    def version(self) -> str | None:
        with self._lock:
            if self._active is None:
                return None
            return self._active.config.version

    # ── Inference ─────────────────────────────────────────────────────────────

    @torch.no_grad()
    def predict(
        self,
        sensor_seq: torch.Tensor,
        images: torch.Tensor | None = None,
        thermal_features: torch.Tensor | None = None,
        sensor_lengths: torch.Tensor | None = None,
    ) -> PredictionResult:
        """
        Run inference and return a structured result.

        Inputs are moved to the model device automatically.

        Parameters
        ----------
        sensor_seq        : (B, T, sensor_input_dim) — required.
        images            : (B, C, H, W)             — optional.
        thermal_features  : (B, thermal_feature_dim) — optional (pre-extracted).
        sensor_lengths    : (B,)                     — optional, for packed LSTM.

        Returns
        -------
        PredictionResult  (batch size 1 only; for batched inference call
                          ``predict_batch()`` instead).
        """
        with self._lock:
            loaded = self._active

        if loaded is None:
            raise RuntimeError("No model loaded.  Call load() before predict().")

        dev = loaded.device

        sensor_seq = sensor_seq.to(dev)
        if images          is not None: images          = images.to(dev)
        if thermal_features is not None: thermal_features = thermal_features.to(dev)
        if sensor_lengths  is not None: sensor_lengths  = sensor_lengths.to(dev)

        t0 = time.perf_counter()

        out: ModelOutput = loaded.model(
            sensor_seq=sensor_seq,
            images=images,
            thermal_features=thermal_features,
            sensor_lengths=sensor_lengths,
        )

        inference_ms = (time.perf_counter() - t0) * 1000.0

        # Scalars — assume batch size 1 for simplicity in this helper.
        moisture = float(out.moisture_pct[0].item())

        std: float | None = None
        lower = moisture
        upper = moisture
        confidence = 1.0

        if out.log_var is not None:
            std = float(torch.exp(out.log_var[0] / 2.0).item())
            lower = max(0.0, moisture - 1.96 * std)
            upper = min(100.0, moisture + 1.96 * std)
            # Confidence: narrower CI → higher confidence.
            # A std of 0 → confidence 1.0; std of 50 → confidence ~0.
            confidence = float(max(0.0, min(1.0, 1.0 - (std / 50.0))))

        return PredictionResult(
            moisture_pct=round(moisture, 4),
            confidence=round(confidence, 4),
            std=round(std, 4) if std is not None else None,
            lower_bound=round(lower, 4),
            upper_bound=round(upper, 4),
            inference_ms=round(inference_ms, 2),
            model_version=loaded.config.version,
        )

    # ── Private helpers ───────────────────────────────────────────────────────

    @staticmethod
    def _select_device() -> torch.device:
        """Prefer CUDA → MPS (Apple Silicon) → CPU."""
        if torch.cuda.is_available():
            return torch.device("cuda")
        if torch.backends.mps.is_available():
            return torch.device("mps")
        return torch.device("cpu")


# ---------------------------------------------------------------------------
# Module-level singleton — imported by main.py and health.py
# ---------------------------------------------------------------------------

model_registry = ModelRegistry()
