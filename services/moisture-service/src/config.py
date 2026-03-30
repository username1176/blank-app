"""
Application settings loaded from environment variables.

Pydantic-Settings reads from the process environment and from a .env file
(when present).  All settings are validated at import time; the process exits
if a required variable is missing or invalid.
"""

from __future__ import annotations

from functools import lru_cache

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=True,
        extra="ignore",
    )

    # ── Server ────────────────────────────────────────────────────────────────
    PORT: int = Field(default=3002, ge=1, le=65535)
    HOST: str = Field(default="0.0.0.0")
    ENVIRONMENT: str = Field(default="development")
    LOG_LEVEL: str = Field(default="info")

    # ── PostgreSQL / TimescaleDB ───────────────────────────────────────────────
    DB_HOST: str = Field(default="localhost")
    DB_PORT: int = Field(default=5432, ge=1, le=65535)
    DB_NAME: str
    DB_USER: str
    DB_PASSWORD: str
    DB_POOL_MIN: int = Field(default=2, ge=0)
    DB_POOL_MAX: int = Field(default=10, ge=1)
    DB_COMMAND_TIMEOUT: float = Field(default=10.0, gt=0)

    # ── JWT ───────────────────────────────────────────────────────────────────
    JWT_SECRET: str = Field(min_length=16)
    JWT_ALGORITHM: str = Field(default="HS256")
    JWT_AUDIENCE: str | None = Field(default=None)
    JWT_ISSUER: str | None = Field(default=None)

    # ── Model ─────────────────────────────────────────────────────────────────
    # Path to the serialised PyTorch moisture model weights (.pt / .pth).
    # Leave empty to skip model loading (useful in CI / unit tests).
    MODEL_PATH: str = Field(default="")
    # Number of Torch intra-op threads (0 = use PyTorch default)
    TORCH_NUM_THREADS: int = Field(default=0, ge=0)
    # Image size fed to the model (pixels, square)
    MODEL_INPUT_SIZE: int = Field(default=224, ge=32)
    # Minimum confidence score to emit a moisture reading (0–1)
    MODEL_CONFIDENCE_THRESHOLD: float = Field(default=0.5, ge=0.0, le=1.0)

    # ── Moisture detection ────────────────────────────────────────────────────
    # Moisture percentage above which an alert is triggered
    MOISTURE_ALERT_THRESHOLD_PCT: float = Field(default=15.0, ge=0.0, le=100.0)

    # ── Training ──────────────────────────────────────────────────────────────
    # Root directory where fine-tuned checkpoints are saved.
    # Layout: {MODEL_CHECKPOINT_DIR}/{customer_id}/{version}/
    MODEL_CHECKPOINT_DIR: str = Field(default="/checkpoints/moisture")
    # Maximum number of labelled samples allowed in a single training submission.
    MAX_TRAINING_SAMPLES: int = Field(default=10_000, ge=10)
    # Maximum size of the uploaded dataset ZIP (megabytes).
    MAX_DATASET_ZIP_MB: int = Field(default=500, ge=1)

    @field_validator("ENVIRONMENT")
    @classmethod
    def validate_environment(cls, v: str) -> str:
        allowed = {"development", "test", "production"}
        if v not in allowed:
            raise ValueError(f"ENVIRONMENT must be one of {allowed}")
        return v

    @field_validator("LOG_LEVEL")
    @classmethod
    def validate_log_level(cls, v: str) -> str:
        allowed = {"debug", "info", "warning", "error", "critical"}
        if v.lower() not in allowed:
            raise ValueError(f"LOG_LEVEL must be one of {allowed}")
        return v.lower()

    @property
    def db_dsn(self) -> str:
        """asyncpg-compatible DSN."""
        return (
            f"postgresql://{self.DB_USER}:{self.DB_PASSWORD}"
            f"@{self.DB_HOST}:{self.DB_PORT}/{self.DB_NAME}"
        )

    @property
    def db_dsn_sync(self) -> str:
        """psycopg2-compatible DSN."""
        return (
            f"host={self.DB_HOST} port={self.DB_PORT} dbname={self.DB_NAME} "
            f"user={self.DB_USER} password={self.DB_PASSWORD}"
        )

    @property
    def is_production(self) -> bool:
        return self.ENVIRONMENT == "production"


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Return the singleton Settings instance.  Cached after first call."""
    return Settings()
