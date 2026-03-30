"""
Trainer — fine-tuning loop with early stopping and metric tracking.

Fine-tuning strategy
--------------------
Phase 1 (frozen backbone, epochs 0…unfreeze_after_epoch-1):
  Only the SensorLSTM, FusionHead, and OutputHead parameters are updated.
  The ThermalEncoder backbone (ResNet) stays frozen to preserve ImageNet
  features while the model adapts to the customer's moisture distribution.

Phase 2 (full model, epochs unfreeze_after_epoch…max_epochs-1):
  All parameters are updated with a 10× lower LR for the backbone to prevent
  destroying the pretrained representations.

Loss function
-------------
When output_uncertainty=True:  Gaussian negative log-likelihood.
  L = 0.5 × (log_var + (target − mean)² × exp(−log_var))
  This simultaneously trains the mean predictor and the uncertainty estimate;
  the model is penalised for being confidently wrong.

When output_uncertainty=False: Huber loss (δ=5.0 % moisture).
  Robust to label outliers while behaving like MSE near the optimum.
"""

from __future__ import annotations

import copy
import time
from dataclasses import dataclass, field

import torch
import torch.nn as nn
import torch.nn.functional as F
from torch.optim import AdamW
from torch.optim.lr_scheduler import ReduceLROnPlateau
from torch.utils.data import DataLoader

from src.logger import get_logger
from src.model.predictor import ModelOutput, MoisturePredictor

log = get_logger(__name__)


# ---------------------------------------------------------------------------
# Training hyperparameters
# ---------------------------------------------------------------------------

@dataclass
class TrainingConfig:
    """Fine-tuning hyperparameters.  All fields are API-settable."""

    learning_rate:        float = 1e-4
    max_epochs:           int   = 50
    patience:             int   = 10
    val_split:            float = 0.2
    batch_size:           int   = 16
    weight_decay:         float = 1e-4
    # Backbone freezing
    freeze_backbone:      bool  = True
    unfreeze_after_epoch: int   = 10
    # Backbone LR is scaled by this factor during phase 2
    backbone_lr_scale:    float = 0.1
    # Gradient clipping max norm
    grad_clip_norm:       float = 1.0
    # ReduceLROnPlateau scheduler
    lr_patience:          int   = 5
    lr_factor:            float = 0.5
    # Replace the registry model with the best checkpoint after training
    reload_after_training: bool = False
    # Random seed for reproducibility
    seed: int = 42


# ---------------------------------------------------------------------------
# Training result
# ---------------------------------------------------------------------------

@dataclass
class TrainingMetrics:
    best_epoch:          int
    best_val_loss:       float
    final_train_loss:    float
    final_val_loss:      float
    epochs_trained:      int
    stopped_early:       bool
    train_samples:       int
    val_samples:         int
    train_loss_history:  list[float] = field(default_factory=list)
    val_loss_history:    list[float] = field(default_factory=list)
    training_duration_s: float       = 0.0

    def to_dict(self) -> dict:
        import dataclasses  # noqa: PLC0415
        return dataclasses.asdict(self)


# ---------------------------------------------------------------------------
# Early stopping
# ---------------------------------------------------------------------------

class EarlyStopping:
    """
    Stops training when validation loss has not improved for ``patience``
    consecutive epochs.

    Parameters
    ----------
    patience  : Number of epochs to wait without improvement.
    min_delta : Minimum decrease in val_loss to count as improvement.
    """

    def __init__(self, patience: int = 10, min_delta: float = 1e-4) -> None:
        self.patience   = patience
        self.min_delta  = min_delta
        self.counter    = 0
        self.best_loss  = float("inf")
        self.best_epoch = 0
        self.should_stop = False

    def step(self, val_loss: float, epoch: int) -> bool:
        """
        Call after each validation pass.
        Returns True when training should stop.
        """
        if val_loss < self.best_loss - self.min_delta:
            self.best_loss  = val_loss
            self.best_epoch = epoch
            self.counter    = 0
        else:
            self.counter += 1
            if self.counter >= self.patience:
                self.should_stop = True

        return self.should_stop


# ---------------------------------------------------------------------------
# Loss functions
# ---------------------------------------------------------------------------

def _gaussian_nll(output: ModelOutput, targets: torch.Tensor) -> torch.Tensor:
    """
    Gaussian NLL: L = 0.5 * (log_var + (target - mean)^2 * exp(-log_var)).
    Encourages both accurate mean prediction and calibrated uncertainty.
    """
    mean    = output.moisture_pct
    log_var = torch.clamp(output.log_var, min=-10.0, max=10.0)  # type: ignore[arg-type]
    return 0.5 * (log_var + (targets - mean).pow(2) * torch.exp(-log_var)).mean()


def _huber(output: ModelOutput, targets: torch.Tensor, delta: float = 5.0) -> torch.Tensor:
    return F.huber_loss(output.moisture_pct, targets, delta=delta)


def _make_loss_fn(config: "MoisturePredictor") -> ...:
    """Return the appropriate loss function for the model config."""
    # Inspected at call site — see Trainer.__init__
    ...


# ---------------------------------------------------------------------------
# Backbone freeze / unfreeze helpers
# ---------------------------------------------------------------------------

def _freeze_backbone(model: MoisturePredictor) -> None:
    for p in model.thermal_encoder.backbone.parameters():
        p.requires_grad = False


def _unfreeze_backbone(model: MoisturePredictor) -> None:
    for p in model.thermal_encoder.backbone.parameters():
        p.requires_grad = True


def _backbone_params(model: MoisturePredictor) -> list[nn.Parameter]:
    return list(model.thermal_encoder.backbone.parameters())


def _non_backbone_params(model: MoisturePredictor) -> list[nn.Parameter]:
    backbone_ids = {id(p) for p in _backbone_params(model)}
    return [p for p in model.parameters() if id(p) not in backbone_ids]


# ---------------------------------------------------------------------------
# Trainer
# ---------------------------------------------------------------------------

class Trainer:
    """
    Fine-tunes a MoisturePredictor on labelled customer data.

    Parameters
    ----------
    base_model : The loaded base model.  A deep copy is taken immediately so
                 the live registry is never mutated during training.
    config     : Fine-tuning hyperparameters.
    device     : Target compute device (auto-selected if None).
    """

    def __init__(
        self,
        base_model: MoisturePredictor,
        config: TrainingConfig,
        device: torch.device | None = None,
    ) -> None:
        torch.manual_seed(config.seed)

        self.config = config
        self.device = device or self._select_device()

        # Deep-copy so training never touches the live inference model.
        self.model: MoisturePredictor = copy.deepcopy(base_model)
        self.model.to(self.device)

        # Loss function
        self._loss_fn = (
            _gaussian_nll
            if self.model.config.output_uncertainty
            else lambda out, tgt: _huber(out, tgt)
        )

        # Phase-1 optimiser: backbone frozen
        if config.freeze_backbone:
            _freeze_backbone(self.model)

        self._build_optimizer(phase=1)
        self._scheduler = ReduceLROnPlateau(
            self._optimizer,
            mode="min",
            patience=config.lr_patience,
            factor=config.lr_factor,
            min_lr=1e-7,
        )

        # Best-checkpoint buffer (weights only to save memory)
        self._best_weights: dict = {}

    # ── Public API ─────────────────────────────────────────────────────────────

    def fit(
        self,
        train_loader: DataLoader,
        val_loader: DataLoader,
    ) -> tuple[MoisturePredictor, TrainingMetrics]:
        """
        Run the full fine-tuning loop.

        Returns
        -------
        (best_model, metrics)
            best_model has the weights from the epoch with lowest val_loss.
        """
        config  = self.config
        stopper = EarlyStopping(patience=config.patience)

        train_history: list[float] = []
        val_history:   list[float] = []

        n_train = len(train_loader.dataset)  # type: ignore[arg-type]
        n_val   = len(val_loader.dataset)    # type: ignore[arg-type]

        log.info(
            "Fine-tuning started",
            train_samples=n_train,
            val_samples=n_val,
            max_epochs=config.max_epochs,
            patience=config.patience,
            device=str(self.device),
        )

        t_start = time.monotonic()

        for epoch in range(config.max_epochs):

            # ── Phase-2 transition ────────────────────────────────────────────
            if config.freeze_backbone and epoch == config.unfreeze_after_epoch:
                _unfreeze_backbone(self.model)
                self._build_optimizer(phase=2)
                log.info("Backbone unfrozen — entering full fine-tune phase", epoch=epoch)

            # ── Train pass ───────────────────────────────────────────────────
            train_loss = self._train_epoch(train_loader)

            # ── Validation pass ──────────────────────────────────────────────
            val_loss = self._val_epoch(val_loader)

            train_history.append(round(train_loss, 6))
            val_history.append(round(val_loss, 6))

            self._scheduler.step(val_loss)

            log.debug(
                "Epoch complete",
                epoch=epoch,
                train_loss=round(train_loss, 4),
                val_loss=round(val_loss, 4),
            )

            # ── Checkpoint best weights ──────────────────────────────────────
            if val_loss <= stopper.best_loss:
                self._best_weights = copy.deepcopy(self.model.state_dict())

            if stopper.step(val_loss, epoch):
                log.info(
                    "Early stopping triggered",
                    epoch=epoch,
                    best_epoch=stopper.best_epoch,
                    best_val_loss=round(stopper.best_loss, 4),
                )
                break

        duration_s = time.monotonic() - t_start

        # ── Restore best weights ──────────────────────────────────────────────
        if self._best_weights:
            self.model.load_state_dict(self._best_weights)
        self.model.eval()

        metrics = TrainingMetrics(
            best_epoch=stopper.best_epoch,
            best_val_loss=round(stopper.best_loss, 6),
            final_train_loss=round(train_history[-1], 6) if train_history else 0.0,
            final_val_loss=round(val_history[-1], 6)     if val_history   else 0.0,
            epochs_trained=len(train_history),
            stopped_early=stopper.should_stop,
            train_samples=n_train,
            val_samples=n_val,
            train_loss_history=train_history,
            val_loss_history=val_history,
            training_duration_s=round(duration_s, 2),
        )

        log.info(
            "Fine-tuning complete",
            best_epoch=metrics.best_epoch,
            best_val_loss=metrics.best_val_loss,
            epochs_trained=metrics.epochs_trained,
            stopped_early=metrics.stopped_early,
            duration_s=metrics.training_duration_s,
        )

        return self.model, metrics

    # ── Private helpers ────────────────────────────────────────────────────────

    def _train_epoch(self, loader: DataLoader) -> float:
        self.model.train()
        total_loss = 0.0

        for images, sensors, targets, lengths in loader:
            images  = images.to(self.device)
            sensors = sensors.to(self.device)
            targets = targets.to(self.device)
            lengths = lengths.to(self.device)

            self._optimizer.zero_grad(set_to_none=True)

            output: ModelOutput = self.model(
                sensor_seq=sensors,
                images=images,
                sensor_lengths=lengths,
            )

            loss = self._loss_fn(output, targets)
            loss.backward()

            torch.nn.utils.clip_grad_norm_(
                self.model.parameters(),
                max_norm=self.config.grad_clip_norm,
            )
            self._optimizer.step()
            total_loss += loss.item()

        return total_loss / max(len(loader), 1)

    @torch.no_grad()
    def _val_epoch(self, loader: DataLoader) -> float:
        self.model.eval()
        total_loss = 0.0

        for images, sensors, targets, lengths in loader:
            images  = images.to(self.device)
            sensors = sensors.to(self.device)
            targets = targets.to(self.device)
            lengths = lengths.to(self.device)

            output: ModelOutput = self.model(
                sensor_seq=sensors,
                images=images,
                sensor_lengths=lengths,
            )
            total_loss += self._loss_fn(output, targets).item()

        return total_loss / max(len(loader), 1)

    def _build_optimizer(self, phase: int) -> None:
        """
        Phase 1 — only non-backbone parameters (backbone frozen).
        Phase 2 — all parameters; backbone gets a 10× lower LR.
        """
        lr = self.config.learning_rate
        wd = self.config.weight_decay

        if phase == 1:
            params = [{"params": _non_backbone_params(self.model), "lr": lr}]
        else:
            params = [
                {"params": _non_backbone_params(self.model), "lr": lr},
                {
                    "params": _backbone_params(self.model),
                    "lr": lr * self.config.backbone_lr_scale,
                },
            ]

        self._optimizer = AdamW(params, weight_decay=wd)

    @staticmethod
    def _select_device() -> torch.device:
        if torch.cuda.is_available():
            return torch.device("cuda")
        if torch.backends.mps.is_available():
            return torch.device("mps")
        return torch.device("cpu")
