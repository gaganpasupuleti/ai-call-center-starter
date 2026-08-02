# Phase 4B — Self-hosted streaming speech-to-text

## Architecture

```text
SmartPing (G.711 μ-law 8 kHz, 160 B / 20 ms)
  → Node call-center app (decode base64 → raw bytes)
  → private WebSocket /v1/stream (one connection per call)
  → Python speech-to-text service
       ├── μ-law → PCM16 / float32
       ├── Silero VAD ONNX (8 kHz, 256-sample windows)
       ├── per-connection utterance buffer
       └── Faster-Whisper Small multilingual (CPU int8)
  → final transcript JSON
  → VoicePipeline.handleTranscript()
  → AdmissionsResponseEngine (Phase 4A)
  → mock TTS (Phase 4B keeps mock / Edge dialer TTS unchanged)
```

## Selected repositories

| Role | Repository | Notes |
|------|------------|-------|
| VAD | [snakers4/silero-vad](https://github.com/snakers4/silero-vad) | ONNX backend, 8 kHz / 256 samples |
| ASR | [SYSTRAN/faster-whisper](https://github.com/SYSTRAN/faster-whisper) | `small`, CPU, int8 |

No OpenAI, Deepgram, Azure, Google, AWS, ElevenLabs, Speaches, LocalAI, Kokoro, Piper, or LLM.

## Why a separate STT service

- CPU-heavy Whisper inference stays out of the Node event loop
- Independent scaling / Railway service lifecycle
- Private networking (`*.railway.internal`) keeps audio off the public internet
- Node app remains deployable with `VOICE_STT_PROVIDER=mock` when the Python service is absent

## WebSocket protocol

1. Client connects to `STT_STREAM_URL` (optional `Authorization: Bearer <STT_SERVICE_TOKEN>`).
2. Client sends JSON `start` (`streamSid`, `language` ∈ `en|te|auto`, `encoding=mulaw`, `sampleRate=8000`).
3. Server replies `ready`.
4. Client sends **raw binary** μ-law frames (not JSON/base64).
5. Server emits `speech_started` → `speech_ended` → `transcript` (or `no_speech` / `error`).
6. Client sends `stop`; server flushes a valid pending utterance when possible.

## 8 kHz μ-law and Silero windows

SmartPing frames are 160 samples. Silero at 8 kHz expects 256-sample windows. The service keeps a remainder buffer and never assumes one SmartPing frame == one VAD window.

## Utterance lifecycle

Pre-roll → speech start → buffer → ≥800 ms ending silence (configurable) → finalize → transcribe once → reset. Force-finalize at `VAD_MAX_UTTERANCE_MS`. Discard below `VAD_MIN_SPEECH_MS`. Sessions never share buffers.

**Overlapping transcripts (Node):** while a response is in flight, at most **one** pending finalized transcript is retained; additional finals are dropped until the slot frees.

**Pending audio (Node):** before `ready`, buffer ≤ `STT_MAX_PENDING_AUDIO_BYTES` (default 16000 ≈ 2 s). Overflow drops **oldest** frames and records `stt_audio_overflow`.

## Faster-Whisper settings

```text
WHISPER_MODEL=small
WHISPER_DEVICE=cpu
WHISPER_COMPUTE_TYPE=int8
WHISPER_BEAM_SIZE=1
WHISPER_CONDITION_ON_PREVIOUS_TEXT=false
STT_MAX_CONCURRENT_TRANSCRIPTIONS=2
```

Language `en` / `te` is passed explicitly. `auto` returns detected language + probability. Task is always `transcribe` (never translate).

## Local startup

```bash
cd services/speech-to-text
python -m venv .venv
# activate venv
pip install -r requirements-dev.txt
pytest
uvicorn app.main:app --host 127.0.0.1 --port 8000
```

Node (default mock STT):

```bash
VOICE_STT_PROVIDER=mock npm run simulate:smartping-stream
```

Streaming mode (Python service required):

```bash
VOICE_STT_PROVIDER=faster-whisper-streaming
STT_STREAM_URL=ws://127.0.0.1:8000/v1/stream
```

## Docker

```bash
cd services/speech-to-text
docker build -t codequest-speech-to-text .
docker run --rm -p 8000:8000 -e STT_LOAD_MODEL_ON_STARTUP=false codequest-speech-to-text
curl http://127.0.0.1:8000/healthz
curl http://127.0.0.1:8000/readyz
```

Use `--build-arg DOWNLOAD_MODELS=true` to bake models into `/models`.

## Railway private networking

- Deploy `services/speech-to-text` as its own service (no public domain required).
- Point the Node app at `ws://<stt-service>.railway.internal:8000/v1/stream`.
- Prefer empty public exposure + optional `STT_SERVICE_TOKEN`.
- Keep `VOICE_STT_PROVIDER=mock` until the STT service is healthy.

## Environment variables

See root `.env.example` (`VOICE_STT_PROVIDER`, `STT_*`) and Python VAD/Whisper vars in `services/speech-to-text/app/config.py`.

## Model download

```bash
python scripts/download_models.py --download-root ./models --silero-out ./models/silero_vad.onnx
```

Unit tests never download models (fakes / DI only).

## No-raw-audio policy

- No customer utterance files in app storage
- In-memory WAV (`BytesIO`) for Whisper only
- No binary audio logging
- Transcripts may enter existing session metadata (length-bounded)

## Failure handling

Safe codes: `stt_connect_failed`, `stt_connect_timeout`, `stt_protocol_error`, `stt_service_closed`, `stt_transcription_timeout`, `stt_model_unavailable`, `stt_audio_overflow`. The SmartPing call continues; live-call activation stays disabled.

## Known limitations

- CPU `small` int8 latency can exceed 1 s for longer utterances
- Concurrent transcriptions capped (default 2)
- No full barge-in / duplex interruption yet
- Mock TTS still used for pipeline replies
- Silero ONNX must be present or loadable via package cache for production quality VAD

## Phase 4C boundary

Phase 4C replaces mock/online TTS for English with **Kokoro**. Do not implement Kokoro or Piper in 4B.
