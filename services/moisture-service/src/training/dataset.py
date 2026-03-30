"""
MoistureDataset — PyTorch Dataset built from a customer-supplied ZIP archive.

Expected ZIP layout
-------------------
dataset.zip/
├── labels.json          ← required, array of LabelEntry objects
└── images/              ← images referenced by labels.json filename field
    ├── pile_north_001.jpg
    ├── pile_north_002.png
    └── ...

labels.json example
-------------------
[
  {
    "filename": "images/pile_north_001.jpg",
    "moisture_pct": 17.4,
    "sensor_readings": [
      {"temperature_c": 22.1, "relative_humidity_pct": 68.0, "timestamp": "2026-03-01T09:00:00Z"},
      {"temperature_c": 22.5, "relative_humidity_pct": 67.0, "timestamp": "2026-03-01T09:05:00Z"}
    ],
    "ambient_temp_c": 22.5,
    "ambient_humidity_pct": 67.0
  },
  ...
]

Sensor readings are optional per sample.  Missing readings produce a single
zero-feature timestep so the LSTM always receives valid input.
"""

from __future__ import annotations

import io
import json
import zipfile
from dataclasses import dataclass, field
from typing import Callable

import torch
from pydantic import BaseModel, Field
from torch.utils.data import DataLoader, Dataset

from src.model.preprocessing import (
    SensorReadingInput,
    build_sensor_tensor,
    default_sensor_tensor,
    preprocess_thermal_image,
)

# ---------------------------------------------------------------------------
# Label schema
# ---------------------------------------------------------------------------

class LabelEntry(BaseModel):
    """One labelled sample inside labels.json."""
    filename:             str
    moisture_pct:         float = Field(ge=0.0, le=100.0)
    sensor_readings:      list[dict] = Field(default_factory=list)
    ambient_temp_c:       float | None = None
    ambient_humidity_pct: float | None = None


# ---------------------------------------------------------------------------
# Internal sample container
# ---------------------------------------------------------------------------

@dataclass
class _Sample:
    filename:             str
    moisture_pct:         float
    sensors:              list[SensorReadingInput]
    ambient_temp_c:       float | None
    ambient_humidity_pct: float | None


# ---------------------------------------------------------------------------
# Dataset
# ---------------------------------------------------------------------------

class MoistureDataset(Dataset[tuple[torch.Tensor, torch.Tensor, torch.Tensor]]):
    """
    Loads (image, sensor_seq, moisture_pct) triples from a ZIP archive.

    Parameters
    ----------
    zip_bytes   : Raw bytes of the uploaded ZIP file.
    input_size  : Spatial size for thermal image resizing (pixels, square).
    transform   : Optional additional transform applied to the image tensor.
    """

    def __init__(
        self,
        zip_bytes: bytes,
        input_size: int = 224,
        transform: Callable[[torch.Tensor], torch.Tensor] | None = None,
    ) -> None:
        self.input_size = input_size
        self.transform  = transform

        self._zf     = zipfile.ZipFile(io.BytesIO(zip_bytes))
        self._names  = set(self._zf.namelist())
        self.samples = self._load_labels()

    # ── Validation & parsing ──────────────────────────────────────────────────

    def _load_labels(self) -> list[_Sample]:
        """Parse and validate labels.json; build the sample list."""
        label_candidates = [n for n in self._names if n.endswith("labels.json")]
        if not label_candidates:
            raise ValueError(
                "ZIP must contain a 'labels.json' file at any directory level."
            )
        labels_name = sorted(label_candidates)[0]   # prefer the shortest path

        with self._zf.open(labels_name) as fh:
            raw = json.load(fh)

        if not isinstance(raw, list):
            raise ValueError("labels.json must be a JSON array of label objects.")

        entries = [LabelEntry.model_validate(item) for item in raw]

        samples: list[_Sample] = []
        missing: list[str] = []

        for entry in entries:
            if entry.filename not in self._names:
                missing.append(entry.filename)
                continue

            parsed_sensors: list[SensorReadingInput] = []
            for sr in entry.sensor_readings:
                try:
                    parsed_sensors.append(SensorReadingInput.model_validate(sr))
                except Exception:  # noqa: BLE001
                    pass  # skip malformed individual readings

            samples.append(_Sample(
                filename=entry.filename,
                moisture_pct=entry.moisture_pct,
                sensors=parsed_sensors,
                ambient_temp_c=entry.ambient_temp_c,
                ambient_humidity_pct=entry.ambient_humidity_pct,
            ))

        if missing:
            raise ValueError(
                f"{len(missing)} file(s) listed in labels.json not found in ZIP: "
                + ", ".join(missing[:5])
                + (" …" if len(missing) > 5 else "")
            )

        if not samples:
            raise ValueError("No valid labelled samples found in the dataset.")

        return samples

    # ── Dataset protocol ─────────────────────────────────────────────────────

    def __len__(self) -> int:
        return len(self.samples)

    def __getitem__(
        self, idx: int
    ) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
        """
        Returns
        -------
        image      : (1, H, W) float32 tensor
        sensor_seq : (T, 6)    float32 tensor (T=1 when no readings supplied)
        target     : ()        float32 scalar — moisture percentage
        """
        sample = self.samples[idx]

        # ── Image ──────────────────────────────────────────────────────────────
        with self._zf.open(sample.filename) as fh:
            img_bytes = fh.read()

        image = preprocess_thermal_image(img_bytes, input_size=self.input_size)
        image = image.squeeze(0)   # (1, 1, H, W) → (1, H, W)

        if self.transform is not None:
            image = self.transform(image)

        # ── Sensor sequence ────────────────────────────────────────────────────
        if sample.sensors:
            sensor_seq = build_sensor_tensor(sample.sensors).squeeze(0)  # (T, 6)
        else:
            sensor_seq = default_sensor_tensor().squeeze(0)               # (1, 6)

        # ── Target ─────────────────────────────────────────────────────────────
        target = torch.tensor(sample.moisture_pct, dtype=torch.float32)

        return image, sensor_seq, target

    def close(self) -> None:
        self._zf.close()


# ---------------------------------------------------------------------------
# Collate function for variable-length sensor sequences
# ---------------------------------------------------------------------------

def moisture_collate_fn(
    batch: list[tuple[torch.Tensor, torch.Tensor, torch.Tensor]],
) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor, torch.Tensor]:
    """
    Pad sensor sequences to the longest in the mini-batch.

    Returns
    -------
    images   : (B, 1, H, W)
    sensors  : (B, T_max, 6)   — zero-padded
    targets  : (B,)
    lengths  : (B,)             — true sequence lengths for pack_padded_sequence
    """
    images, sensors, targets = zip(*batch)

    images  = torch.stack(images)                                     # (B, 1, H, W)
    targets = torch.stack(targets)                                     # (B,)
    lengths = torch.tensor([s.shape[0] for s in sensors], dtype=torch.long)

    max_t  = int(lengths.max().item())
    feat   = sensors[0].shape[1]                                       # 6
    padded = torch.zeros(len(sensors), max_t, feat)
    for i, seq in enumerate(sensors):
        t = seq.shape[0]
        padded[i, :t] = seq

    return images, padded, targets, lengths


# ---------------------------------------------------------------------------
# DataLoader factory
# ---------------------------------------------------------------------------

def make_loaders(
    dataset: MoistureDataset,
    val_split: float = 0.2,
    batch_size: int = 16,
    num_workers: int = 0,
    seed: int = 42,
) -> tuple[DataLoader, DataLoader]:
    """
    Split ``dataset`` into train/val subsets and return DataLoaders.

    Parameters
    ----------
    val_split   : Fraction of samples reserved for validation (0.05–0.5).
    batch_size  : Mini-batch size for both loaders.
    num_workers : Subprocess workers (0 = load in main process; safe for ZIP).
    seed        : Random seed for the reproducible split.

    Returns
    -------
    (train_loader, val_loader)
    """
    from torch.utils.data import random_split  # noqa: PLC0415

    n       = len(dataset)
    n_val   = max(1, round(n * val_split))
    n_train = n - n_val

    if n_train < 1:
        raise ValueError(
            f"Dataset too small ({n} samples) for val_split={val_split}. "
            "Need at least 2 samples."
        )

    generator = torch.Generator().manual_seed(seed)
    train_set, val_set = random_split(dataset, [n_train, n_val], generator=generator)

    train_loader = DataLoader(
        train_set,
        batch_size=batch_size,
        shuffle=True,
        collate_fn=moisture_collate_fn,
        num_workers=num_workers,
        pin_memory=False,
        drop_last=len(train_set) > batch_size,  # avoid single-sample last batch
    )
    val_loader = DataLoader(
        val_set,
        batch_size=batch_size,
        shuffle=False,
        collate_fn=moisture_collate_fn,
        num_workers=num_workers,
        pin_memory=False,
    )

    return train_loader, val_loader
