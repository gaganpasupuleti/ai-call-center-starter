# syntax=docker/dockerfile:1
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    WHISPER_DOWNLOAD_ROOT=/models \
    WHISPER_MODEL=small \
    WHISPER_LOCAL_FILES_ONLY=true \
    STT_LOAD_MODEL_ON_STARTUP=true \
    PORT=8000

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 10001 appuser \
    && mkdir -p /models \
    && chown -R appuser:appuser /app /models

COPY requirements.txt .
RUN pip install --upgrade pip \
    && pip install -r requirements.txt

COPY app ./app
COPY scripts ./scripts

# Staging default: bake Faster-Whisper Small + Silero ONNX into the image.
# Opt out for local/dev builds: --build-arg DOWNLOAD_MODELS=false
ARG DOWNLOAD_MODELS=true
ARG WHISPER_MODEL=small
RUN if [ "$DOWNLOAD_MODELS" = "true" ]; then \
      echo "Baking STT models (DOWNLOAD_MODELS=true WHISPER_MODEL=${WHISPER_MODEL})" ; \
      python scripts/download_models.py \
        --model "${WHISPER_MODEL}" \
        --download-root /models \
        --silero-out /models/silero_vad.onnx ; \
      echo "STT model bake complete" ; \
    else \
      echo "Skipping STT model bake (DOWNLOAD_MODELS=false)" ; \
    fi \
    && chown -R appuser:appuser /models

USER appuser
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/healthz')" || exit 1

CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
