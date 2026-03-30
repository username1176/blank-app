# ── Jetson / L4T build ────────────────────────────────────────────────────────
# Default base is a standard Python slim image for local development and CI.
# For NVIDIA Jetson (JetPack 5.x / L4T 35.x), override at build time:
#
#   docker build \
#     --build-arg BASE_IMAGE=nvcr.io/nvidia/l4t-base:r35.3.1 \
#     --build-arg INSTALL_OPENCV_PIP=0 \
#     -t edge-processor:jetson .
#
# The L4T base image ships Python 3.8+ and a JetPack-compiled OpenCV (with
# CUDA + GStreamer support) at /usr/lib/python3/dist-packages/cv2.  Setting
# INSTALL_OPENCV_PIP=0 skips the pip install so the system OpenCV is used.
# ─────────────────────────────────────────────────────────────────────────────

ARG BASE_IMAGE=python:3.10-slim
FROM ${BASE_IMAGE}

# When 1 (default), install opencv-python-headless via pip.
# Set to 0 on Jetson where OpenCV is already present from JetPack.
ARG INSTALL_OPENCV_PIP=1

# ── System dependencies ───────────────────────────────────────────────────────
# GStreamer runtime + V4L2 utils are installed on all variants so the GStreamer
# OpenCV backend can be used when USE_GSTREAMER=true is set at runtime.
RUN apt-get update && apt-get install -y --no-install-recommends \
        # GStreamer core + common plugins (needed for RTSP and hardware decode)
        libgstreamer1.0-0 \
        gstreamer1.0-plugins-base \
        gstreamer1.0-plugins-good \
        gstreamer1.0-plugins-bad \
        gstreamer1.0-plugins-ugly \
        gstreamer1.0-libav \
        gstreamer1.0-tools \
        # V4L2 utilities for USB thermal cameras
        v4l-utils \
        # Image codec libraries
        libgl1 \
        libglib2.0-0 \
        libsm6 \
        libxext6 \
        # Misc
        curl \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# ── Python dependencies ───────────────────────────────────────────────────────
WORKDIR /app

COPY requirements.txt .

# Install everything except OpenCV first (faster layer caching).
RUN pip install --no-cache-dir \
        httpx[http2] \
        pydantic-settings \
        pydantic \
        anyio \
        Pillow \
        python-json-logger \
        numpy

# Conditionally install OpenCV via pip (skip on Jetson).
RUN if [ "${INSTALL_OPENCV_PIP}" = "1" ]; then \
        pip install --no-cache-dir "opencv-python-headless>=4.8,<5"; \
    fi

# ── Application source ────────────────────────────────────────────────────────
COPY src/ ./src/

# ── Non-root user ─────────────────────────────────────────────────────────────
RUN useradd -m -u 1001 edge && chown -R edge:edge /app
USER edge

# ── Runtime ───────────────────────────────────────────────────────────────────
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONPATH=/app

# Expose nothing — this is a headless processing worker with no inbound traffic.

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD python3 -c "import json,sys,pathlib; \
        f=pathlib.Path('/tmp/edge_health.json'); \
        sys.exit(0) if f.exists() and (import('time'), float(json.loads(f.read_text()).get('ts',0)) > import('time').time()-120)[1] else sys.exit(1)" \
    || exit 1

CMD ["python3", "-m", "src.main"]
