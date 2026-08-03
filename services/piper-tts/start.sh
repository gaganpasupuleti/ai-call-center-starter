#!/usr/bin/env bash
set -euo pipefail

PORT="${PORT:-5000}"
DATA_DIR="${PIPER_DATA_DIR:-/models}"
DEFAULT_VOICE="${PIPER_DEFAULT_VOICE:-te_IN-padmavathi-medium}"

if [[ ! -f "${DATA_DIR}/${DEFAULT_VOICE}.onnx" ]]; then
  echo "Missing default voice model: ${DATA_DIR}/${DEFAULT_VOICE}.onnx" >&2
  echo "Run: python scripts/download_voices.py --dest ${DATA_DIR}" >&2
  exit 1
fi

exec python -m piper.http_server \
  --host 0.0.0.0 \
  --port "${PORT}" \
  --data-dir "${DATA_DIR}" \
  -m "${DEFAULT_VOICE}"
