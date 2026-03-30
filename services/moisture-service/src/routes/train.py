"""
Training endpoints.

POST /train
    Accept a ZIP dataset, validate it, start a background fine-tuning job,
    and return a job_id immediately.

GET  /train/{job_id}
    Poll job status and, when complete, retrieve training metrics and the
    path of the saved checkpoint.

Design notes
------------
- Training is CPU/GPU-intensive (seconds to minutes).  The response is
  returned immediately with a job_id; callers poll GET /train/{job_id}.
- FastAPI runs synchronous background callables in a thread pool automatically,
  so the event loop is never blocked during training.
- The in-memory job store is appropriate for a single-replica deployment.
  Replace with a Redis-backed store for horizontal scaling.
- A per-customer lock prevents two training jobs for the same customer from
  running concurrently and writing to the same checkpoint path.
"""

from __future__ import annotations

import json
import threading
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Literal

from fastapi import (
    APIRouter,
    BackgroundTasks,
    Depends,
    File,
    Form,
    HTTPException,
    UploadFile,
    status,
)
from pydantic import BaseModel, Field as PydanticField

from src.config import get_settings
from src.logger import get_logger
from src.middleware.auth import AuthPayload, get_current_user
from src.model import model_registry
from src.training.dataset import MoistureDataset, make_loaders
from src.training.trainer import Trainer, TrainingConfig, TrainingMetrics
from src.training.versioning import generate_version, save_checkpoint

log = get_logger(__name__)
router = APIRouter(tags=["training"])

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

_MIN_SAMPLES  = 10           # minimum labelled images required
_MAX_ZIP_MB   = 500          # hard cap; configurable via MAX_DATASET_ZIP_MB
_LABEL_FILE   = "labels.json"

# ---------------------------------------------------------------------------
# In-memory job store
# ---------------------------------------------------------------------------

JobStatus = Literal["queued", "running", "completed", "failed"]


@dataclass
class TrainingJob:
    job_id:           str
    customer_id:      str
    status:           JobStatus     = "queued"
    created_at:       datetime      = field(default_factory=lambda: datetime.now(tz=timezone.utc))
    started_at:       datetime | None = None
    completed_at:     datetime | None = None
    metrics:          TrainingMetrics | None = None
    model_version:    str | None    = None
    checkpoint_path:  str | None    = None
    error:            str | None    = None


_jobs: dict[str, TrainingJob] = {}
_jobs_lock = threading.Lock()

# Per-customer lock: prevents concurrent training for the same tenant.
_customer_training_locks: dict[str, threading.Lock] = {}
_customer_locks_lock = threading.Lock()


def _get_customer_lock(customer_id: str) -> threading.Lock:
    with _customer_locks_lock:
        if customer_id not in _customer_training_locks:
            _customer_training_locks[customer_id] = threading.Lock()
        return _customer_training_locks[customer_id]


def _update_job(job_id: str, **kwargs) -> None:
    with _jobs_lock:
        job = _jobs.get(job_id)
        if job is not None:
            for k, v in kwargs.items():
                setattr(job, k, v)


# ---------------------------------------------------------------------------
# Request / response models
# ---------------------------------------------------------------------------

class TrainingConfigRequest(BaseModel):
    """Optional JSON blob passed via the ``config`` form field."""
    learning_rate:        float = PydanticField(default=1e-4,  gt=0,    le=0.1)
    max_epochs:           int   = PydanticField(default=50,    ge=1,    le=500)
    patience:             int   = PydanticField(default=10,    ge=1,    le=100)
    val_split:            float = PydanticField(default=0.2,   ge=0.05, le=0.5)
    batch_size:           int   = PydanticField(default=16,    ge=1,    le=256)
    weight_decay:         float = PydanticField(default=1e-4,  ge=0.0)
    freeze_backbone:      bool  = True
    unfreeze_after_epoch: int   = PydanticField(default=10,    ge=0)
    reload_after_training: bool = False


class TrainingJobResponse(BaseModel):
    """Returned immediately by POST /train."""
    job_id:     str
    status:     JobStatus
    created_at: str
    message:    str


class TrainingStatusData(BaseModel):
    """Inner data payload for GET /train/{job_id}."""
    job_id:          str
    status:          JobStatus
    customer_id:     str
    created_at:      str
    started_at:      str | None
    completed_at:    str | None
    model_version:   str | None
    checkpoint_path: str | None
    error:           str | None
    metrics:         dict | None


class TrainingStatusResponse(BaseModel):
    data: TrainingStatusData


# ---------------------------------------------------------------------------
# Background training function (sync — FastAPI runs this in a thread pool)
# ---------------------------------------------------------------------------

def _run_training(
    job_id:      str,
    customer_id: str,
    zip_bytes:   bytes,
    cfg:         TrainingConfig,
) -> None:
    """
    Executed in a FastAPI background thread.  All exceptions are caught and
    written to the job store so the polling endpoint can surface them cleanly.
    """
    customer_lock = _get_customer_lock(customer_id)

    if not customer_lock.acquire(blocking=False):
        _update_job(
            job_id,
            status="failed",
            completed_at=datetime.now(tz=timezone.utc),
            error="Another training job is already running for this customer. "
                  "Wait for it to complete before submitting a new one.",
        )
        return

    try:
        _update_job(job_id, status="running", started_at=datetime.now(tz=timezone.utc))

        settings = get_settings()

        # ── Build dataset ──────────────────────────────────────────────────────
        log.info("Building dataset from ZIP", job_id=job_id, customer_id=customer_id)
        dataset = MoistureDataset(zip_bytes, input_size=settings.MODEL_INPUT_SIZE)

        if len(dataset) < _MIN_SAMPLES:
            raise ValueError(
                f"Dataset contains only {len(dataset)} labelled samples. "
                f"At least {_MIN_SAMPLES} are required for fine-tuning."
            )

        train_loader, val_loader = make_loaders(
            dataset,
            val_split=cfg.val_split,
            batch_size=cfg.batch_size,
        )

        # ── Get base model ─────────────────────────────────────────────────────
        if not model_registry.is_loaded():
            raise RuntimeError(
                "No base model is loaded.  Configure MODEL_PATH before training."
            )

        # Access the live model — Trainer deep-copies it, so inference is unaffected.
        with model_registry._lock:  # noqa: SLF001
            base_model  = model_registry._active.model   # noqa: SLF001
            model_config = model_registry._active.config  # noqa: SLF001

        # ── Fine-tune ──────────────────────────────────────────────────────────
        trainer = Trainer(base_model=base_model, config=cfg)
        fine_tuned_model, metrics = trainer.fit(train_loader, val_loader)

        # ── Version and save ───────────────────────────────────────────────────
        version        = generate_version(customer_id)
        checkpoint_dir = save_checkpoint(
            model=fine_tuned_model,
            model_config=model_config,
            metrics=metrics,
            base_dir=settings.MODEL_CHECKPOINT_DIR,
            customer_id=customer_id,
            version=version,
        )

        metrics.training_duration_s = metrics.training_duration_s  # already set

        log.info(
            "Training job completed",
            job_id=job_id,
            version=version,
            checkpoint=str(checkpoint_dir),
            best_val_loss=metrics.best_val_loss,
            epochs_trained=metrics.epochs_trained,
        )

        # ── Optionally reload the registry ────────────────────────────────────
        if cfg.reload_after_training:
            try:
                model_registry.load(
                    path=str(checkpoint_dir),
                    input_size=settings.MODEL_INPUT_SIZE,
                    num_threads=settings.TORCH_NUM_THREADS,
                )
                log.info(
                    "Registry reloaded with fine-tuned model",
                    job_id=job_id,
                    version=version,
                )
            except Exception as reload_err:  # noqa: BLE001
                log.warning(
                    "reload_after_training=True but reload failed — "
                    "checkpoint saved, registry unchanged",
                    error=str(reload_err),
                )

        _update_job(
            job_id,
            status="completed",
            completed_at=datetime.now(tz=timezone.utc),
            metrics=metrics,
            model_version=version,
            checkpoint_path=str(checkpoint_dir),
        )

        dataset.close()

    except Exception as exc:  # noqa: BLE001
        log.error(
            "Training job failed",
            job_id=job_id,
            customer_id=customer_id,
            error=str(exc),
            exc_info=True,
        )
        _update_job(
            job_id,
            status="failed",
            completed_at=datetime.now(tz=timezone.utc),
            error=str(exc),
        )
    finally:
        customer_lock.release()


# ---------------------------------------------------------------------------
# POST /train
# ---------------------------------------------------------------------------

@router.post(
    "/train",
    response_model=TrainingJobResponse,
    status_code=status.HTTP_202_ACCEPTED,
    summary="Submit a fine-tuning job",
    description=(
        "Upload a ZIP dataset and optional hyperparameters.  Returns a job_id "
        "immediately; poll GET /train/{job_id} for status and metrics."
    ),
)
async def submit_training(
    background_tasks: BackgroundTasks,
    dataset: UploadFile = File(
        ...,
        description=(
            "ZIP archive containing labels.json and thermal image files. "
            "See API documentation for the expected ZIP layout."
        ),
    ),
    config: str | None = Form(
        default=None,
        description="Optional JSON object with fine-tuning hyperparameters.",
    ),
    auth: AuthPayload = Depends(get_current_user),
) -> TrainingJobResponse:

    settings = get_settings()

    # ── Validate base model is available ──────────────────────────────────────
    if not model_registry.is_loaded():
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={
                "code": "MODEL_NOT_LOADED",
                "message": "No base model loaded.  Set MODEL_PATH before submitting training jobs.",
            },
        )

    # ── Validate and read ZIP ──────────────────────────────────────────────────
    ct = (dataset.content_type or "").split(";")[0].strip().lower()
    if ct and ct not in {"application/zip", "application/x-zip-compressed",
                         "application/octet-stream", "multipart/x-zip"}:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"code": "INVALID_FILE_TYPE", "message": "dataset must be a ZIP file."},
        )

    max_bytes = (settings.MAX_DATASET_ZIP_MB) * 1024 * 1024
    zip_bytes = await dataset.read()

    if len(zip_bytes) > max_bytes:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail={
                "code": "DATASET_TOO_LARGE",
                "message": (
                    f"ZIP exceeds {settings.MAX_DATASET_ZIP_MB} MB limit "
                    f"({len(zip_bytes) / 1024 / 1024:.1f} MB received)."
                ),
            },
        )

    # Quick structure sanity-check before handing off to the background thread.
    import zipfile, io  # noqa: E401, PLC0415
    try:
        with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
            names = zf.namelist()
    except zipfile.BadZipFile:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"code": "INVALID_ZIP", "message": "Uploaded file is not a valid ZIP archive."},
        )

    if not any(n.endswith("labels.json") for n in names):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={
                "code": "MISSING_LABELS",
                "message": (
                    "ZIP must contain a 'labels.json' file.  "
                    "See API documentation for the expected format."
                ),
            },
        )

    # ── Parse training config ──────────────────────────────────────────────────
    cfg_request = TrainingConfigRequest()
    if config:
        try:
            cfg_request = TrainingConfigRequest.model_validate(json.loads(config))
        except Exception as exc:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail={"code": "INVALID_CONFIG", "message": str(exc)},
            )

    training_cfg = TrainingConfig(
        learning_rate=cfg_request.learning_rate,
        max_epochs=cfg_request.max_epochs,
        patience=cfg_request.patience,
        val_split=cfg_request.val_split,
        batch_size=cfg_request.batch_size,
        weight_decay=cfg_request.weight_decay,
        freeze_backbone=cfg_request.freeze_backbone,
        unfreeze_after_epoch=cfg_request.unfreeze_after_epoch,
        reload_after_training=cfg_request.reload_after_training,
    )

    # ── Create job record ──────────────────────────────────────────────────────
    job_id = str(uuid.uuid4())
    job    = TrainingJob(job_id=job_id, customer_id=auth.customer_id)
    with _jobs_lock:
        _jobs[job_id] = job

    log.info(
        "Training job queued",
        job_id=job_id,
        customer_id=auth.customer_id,
        zip_size_mb=round(len(zip_bytes) / 1024 / 1024, 2),
        max_epochs=training_cfg.max_epochs,
        patience=training_cfg.patience,
    )

    # ── Dispatch to thread pool ────────────────────────────────────────────────
    background_tasks.add_task(
        _run_training,
        job_id=job_id,
        customer_id=auth.customer_id,
        zip_bytes=zip_bytes,
        cfg=training_cfg,
    )

    return TrainingJobResponse(
        job_id=job_id,
        status="queued",
        created_at=job.created_at.isoformat(),
        message=(
            f"Training job queued.  Poll GET /train/{job_id} for status and metrics."
        ),
    )


# ---------------------------------------------------------------------------
# GET /train/{job_id}
# ---------------------------------------------------------------------------

@router.get(
    "/train/{job_id}",
    response_model=TrainingStatusResponse,
    summary="Get training job status and metrics",
)
async def get_training_status(
    job_id: str,
    auth: AuthPayload = Depends(get_current_user),
) -> TrainingStatusResponse:

    with _jobs_lock:
        job = _jobs.get(job_id)

    if job is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "JOB_NOT_FOUND", "message": f"Training job '{job_id}' not found."},
        )

    # Tenants can only read their own jobs.
    if job.customer_id != auth.customer_id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "JOB_NOT_FOUND", "message": f"Training job '{job_id}' not found."},
        )

    return TrainingStatusResponse(
        data=TrainingStatusData(
            job_id=job.job_id,
            status=job.status,
            customer_id=job.customer_id,
            created_at=job.created_at.isoformat(),
            started_at=job.started_at.isoformat()   if job.started_at   else None,
            completed_at=job.completed_at.isoformat() if job.completed_at else None,
            model_version=job.model_version,
            checkpoint_path=job.checkpoint_path,
            error=job.error,
            metrics=job.metrics.to_dict() if job.metrics else None,
        )
    )
