# =============================================================================
# moisture-service Dockerfile
# Multi-stage build: deps → runtime
# =============================================================================

# ── Stage 1: dependency installation ─────────────────────────────────────────
FROM python:3.12-slim AS deps

WORKDIR /install

# System libraries required by opencv-python and psycopg2-binary
RUN apt-get update && apt-get install -y --no-install-recommends \
        libglib2.0-0 \
        libgl1 \
        libpq-dev \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .

# Install CPU-only torch first from the PyTorch index (avoids the ~2 GB CUDA wheel).
# Then install the rest from PyPI.
RUN pip install --no-cache-dir --upgrade pip \
 && pip install --no-cache-dir \
        torch==2.5.1 \
        torchvision==0.20.1 \
        --index-url https://download.pytorch.org/whl/cpu \
 && pip install --no-cache-dir -r requirements.txt \
        --no-deps torch torchvision   # already installed above

# ── Stage 2: runtime image ────────────────────────────────────────────────────
FROM python:3.12-slim AS runtime

# Non-root user for security
RUN useradd --create-home --shell /bin/bash appuser

WORKDIR /app

# Runtime system libraries (same as deps stage, minus build tools)
RUN apt-get update && apt-get install -y --no-install-recommends \
        libglib2.0-0 \
        libgl1 \
        libpq5 \
    && rm -rf /var/lib/apt/lists/*

# Copy installed packages from the deps stage
COPY --from=deps /usr/local/lib/python3.12/site-packages /usr/local/lib/python3.12/site-packages
COPY --from=deps /usr/local/bin /usr/local/bin

# Copy application source
COPY src/ ./src/

# Torch should not try to write a cache directory at runtime
ENV TORCH_HOME=/tmp/torch
ENV PYTHONUNBUFFERED=1
ENV PYTHONDONTWRITEBYTECODE=1

USER appuser

EXPOSE 3002

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:3002/health/live')"

CMD ["uvicorn", "src.main:app", "--host", "0.0.0.0", "--port", "3002", "--no-access-log"]
