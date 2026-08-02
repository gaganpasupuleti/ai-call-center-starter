# Phase 4C — Self-hosted Kokoro English TTS

## Selected repository

- **Project:** [remsky/Kokoro-FastAPI](https://github.com/remsky/Kokoro-FastAPI)
- **Pinned CPU image:** `ghcr.io/remsky/kokoro-fastapi-cpu:v0.7.0`
- **License:** Apache License 2.0 (see `THIRD_PARTY_NOTICES.md`)
- **API format:** OpenAI-compatible `POST /v1/audio/speech` against the **local** service only — never OpenAI hosted APIs

Do not use the unpinned `:latest` tag in production.

## Architecture

```text
Railway project
├── call-center-app (Node)
│   ├── SmartPing WebSocket
│   ├── deterministic response engine
│   ├── Faster-Whisper STT client
│   ├── TTS language router (EN → Kokoro; TE → Phase 4D)
│   └── PCM 24 kHz → μ-law 8 kHz (ffmpeg-static)
├── speech-to-text (Silero + Faster-Whisper)
└── kokoro-tts (private, no public domain)
```

Private URL example:

```text
http://kokoro-tts.railway.internal:8880
```

## PCM and μ-law

| Stage | Format |
|-------|--------|
| Kokoro output | signed PCM16 LE, mono, **24000 Hz** |
| SmartPing playback | G.711 μ-law, mono, **8000 Hz** |

Conversion uses `ffmpeg-static` with fixed `spawn` arguments (no shell, no temp files).

## Voices

Allowlist (config-driven): `af_bella` (default), `af_sky`, `af_nicole`, `af_sarah`, `am_michael`, `am_adam`, `bf_emma`, `bf_isabella`, `bm_george`.

Remote `GET /v1/audio/voices` is filtered through this allowlist.

## Cache and concurrency

```env
TTS_CACHE_ENABLED=true
TTS_CACHE_MAX_ENTRIES=100
TTS_CACHE_MAX_BYTES=52428800
TTS_CACHE_TTL_MS=3600000
TTS_MAX_CONCURRENT_SYNTHESIS=2
TTS_MAX_PENDING_REQUESTS=10
```

Cache keys: provider + language + voice + speed + normalized text + format version. Bot audio only.

## Language boundary

- English → Kokoro
- Telugu → `tts_language_not_configured` (no Edge fallback, no translation)

## Failure behaviour

No automatic `msedge` fallback. Preserve deterministic decision + actions; record safe `ttsError`; optional DTMF / human transfer via existing engine actions. At most one retry for retryable connection failures.

## Local testing

```bash
docker run --rm -p 8880:8880 ghcr.io/remsky/kokoro-fastapi-cpu:v0.7.0
npm run test:kokoro-local
```

Keep `VOICE_TTS_PROVIDER=mock` until Kokoro is healthy.

## Railway activation order

1. Deploy Kokoro as a **private** Railway service (no public domain).
2. Confirm `GET /v1/audio/voices` on the private network.
3. Run `npm run test:kokoro-local` (or app smoke) against the private URL.
4. Keep `VOICE_TTS_PROVIDER=mock`.
5. Enable `kokoro` in a non-live test environment.
6. Run SmartPing simulator with mock/local STT.
7. Verify English replies and μ-law pacing.
8. Set `VOICE_TTS_PROVIDER=kokoro` only after checks pass.
9. Keep SmartPing live-call flags disabled.

Do not change production Railway variables from automation in this phase.

## Outbound dialer

`OUTBOUND_TTS_PROVIDER=inherit|mock|kokoro|msedge` (default `msedge` preserves current Edge dialer). When set to `kokoro`, English prompts and DTMF clips use Kokoro; Telugu remains unavailable.

## Known limitations

- CPU Kokoro latency can exceed 1s for longer sentences
- Default concurrency is 2
- No Telugu TTS yet
- No barge-in
- Interactive reply TTS still mock until `VOICE_TTS_PROVIDER=kokoro`

## Phase 4D boundary

Phase 4D adds **Piper Telugu TTS** and completes the language router (`en → Kokoro`, `te → Piper`). Do not implement Piper in 4C.
