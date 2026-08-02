# Speech-to-text service (Faster-Whisper + Silero VAD)

Private Python microservice for Phase 4B streaming STT.

## Endpoints

- `GET /healthz` — liveness (no model download)
- `GET /readyz` — model readiness (503 until loaded)
- `WS /v1/stream` — per-call audio WebSocket

## Local development

```bash
python -m venv .venv
# Windows: .venv\Scripts\activate
# Unix: source .venv/bin/activate
pip install -r requirements-dev.txt
pytest
uvicorn app.main:app --host 127.0.0.1 --port 8000
```

Optional model download:

```bash
python scripts/download_models.py --download-root ./models --silero-out ./models/silero_vad.onnx
```

## Docker

```bash
docker build -t codequest-speech-to-text .
docker run --rm -p 8000:8000 -e STT_LOAD_MODEL_ON_STARTUP=false codequest-speech-to-text
```

Set `DOWNLOAD_MODELS=true` at build time to bake Whisper/Silero into `/models`.

## Privacy

No customer audio is written to disk. Transcription uses in-memory WAV buffers only.
