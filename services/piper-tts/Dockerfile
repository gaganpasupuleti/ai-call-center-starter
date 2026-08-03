# syntax=docker/dockerfile:1
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PORT=5000 \
    PIPER_DATA_DIR=/models \
    PIPER_DEFAULT_VOICE=te_IN-padmavathi-medium \
    PIPER_VOICES_REVISION=9f967d15e9ccdf43078586d1476ee70f314401bd

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 10001 appuser \
    && mkdir -p /models \
    && chown -R appuser:appuser /app /models

COPY requirements.txt .
RUN pip install --upgrade pip \
    && pip install -r requirements.txt

COPY scripts ./scripts
COPY start.sh ./start.sh
COPY notices ./notices
RUN chmod +x start.sh scripts/*.py \
    && chown -R appuser:appuser /app

# Staging default: bake approved Telugu voices (Padmavathi + Venkatesh).
# Opt out for local/dev builds: --build-arg DOWNLOAD_VOICES=false
# Pin exact HF revision (not floating main).
ARG DOWNLOAD_VOICES=true
ARG PIPER_VOICES_REVISION=9f967d15e9ccdf43078586d1476ee70f314401bd
RUN set -eux; \
    if [ "$DOWNLOAD_VOICES" = "true" ]; then \
      echo "Baking Piper voices (DOWNLOAD_VOICES=true revision=${PIPER_VOICES_REVISION})" ; \
      python scripts/download_voices.py \
        --dest /models \
        --revision "${PIPER_VOICES_REVISION}" \
        --require-expected-hashes ; \
      python scripts/verify_models.py --dest /models ; \
      echo "Piper voice bake complete" ; \
    else \
      echo "Skipping Piper voice bake (DOWNLOAD_VOICES=false)" ; \
    fi ; \
    chown -R appuser:appuser /models

USER appuser
EXPOSE 5000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:5000/info')" || exit 1

CMD ["./start.sh"]
