#!/usr/bin/env bash
set -euo pipefail

PORT="${PORT:-5000}"
DATA_DIR="${PIPER_DATA_DIR:-/models}"
DEFAULT_VOICE="${PIPER_DEFAULT_VOICE:-te_IN-padmavathi-medium}"

REQUIRED_FILES=(
  "${DATA_DIR}/te_IN-padmavathi-medium.onnx"
  "${DATA_DIR}/te_IN-padmavathi-medium.onnx.json"
  "${DATA_DIR}/te_IN-venkatesh-medium.onnx"
  "${DATA_DIR}/te_IN-venkatesh-medium.onnx.json"
  "${DATA_DIR}/en_US-libritts_r-medium.onnx"
  "${DATA_DIR}/en_US-libritts_r-medium.onnx.json"
)

for path in "${REQUIRED_FILES[@]}"; do
  if [[ ! -f "${path}" ]]; then
    echo "Missing required Piper model asset: ${path}" >&2
    echo "Bake voices with DOWNLOAD_VOICES=true or mount /models" >&2
    exit 1
  fi
done

if [[ ! -f "${DATA_DIR}/${DEFAULT_VOICE}.onnx" ]]; then
  echo "Missing default voice model: ${DATA_DIR}/${DEFAULT_VOICE}.onnx" >&2
  exit 1
fi

exec python -m piper.http_server \
  --host 0.0.0.0 \
  --port "${PORT}" \
  --data-dir "${DATA_DIR}" \
  -m "${DEFAULT_VOICE}"
