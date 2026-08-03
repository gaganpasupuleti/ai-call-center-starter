# Phase 4E.1 — Railway speech-service bring-up and real-audio validation

## Why Phase 4F was blocked

Phase 4E delivered conversation lifecycle code, inject-based local simulation, and
Railway service scaffolding. It did **not** prove:

- Baked Faster-Whisper / Silero / Piper assets in staging images
- Private DNS reachability of STT / Kokoro / Piper from the app
- Aggregate `/api/speech/readiness` green with real providers
- Real μ-law audio through Silero → Faster-Whisper → deterministic engine → Kokoro/Piper

Transcript injection alone is insufficient for a telephone call.

## Scope

| Allowed | Forbidden |
|--------|-----------|
| `speech-e2e` environment only | Production environment changes |
| Synthetic / consented caller audio | Real telephone calls |
| Private Railway networking | SmartPing API / live dialer |
| Deterministic response engine | LLM / paid speech APIs |
| Local Kokoro + Piper | Public STT/Kokoro/Piper domains |

## Model packaging strategy

### speech-to-text

- Dockerfile default: `DOWNLOAD_MODELS=true`, `WHISPER_MODEL=small`
- Assets under `/models`
- Runtime: `WHISPER_LOCAL_FILES_ONLY=true`, `STT_LOAD_MODEL_ON_STARTUP=true`
- `/healthz` = process health; `/readyz` = model ready (HTTP 200 only when ready)
- Opt-out: `--build-arg DOWNLOAD_MODELS=false`

### piper-tts

- Dockerfile default: `DOWNLOAD_VOICES=true`
- Pinned revision: `9f967d15e9ccdf43078586d1476ee70f314401bd`
- Voices: `te_IN-padmavathi-medium`, `te_IN-venkatesh-medium`
- Build verifies Phase 4D SHA-256 digests (`--require-expected-hashes`)
- Startup fails if required `.onnx` / `.onnx.json` files are missing
- Opt-out: `--build-arg DOWNLOAD_VOICES=false`

### kokoro-tts

- Pinned image: `ghcr.io/remsky/kokoro-fastapi-cpu:v0.7.0`
- No public domain
- Voice required: `af_bella`

## Railway layout

| Service | Source | Config | Health | Port | Public domain |
|---------|--------|--------|--------|------|---------------|
| speech-to-text | `railway up ./services/speech-to-text --path-as-root` | `services/speech-to-text/railway.toml` (+ `railway/stt.railway.toml` notes) | `/healthz` | 8000 | none |
| kokoro-tts | pinned GHCR image | `railway/kokoro.NOTES.md` | `/v1/audio/voices` | 8880 | none |
| piper-tts | `railway up ./services/piper-tts --path-as-root` | `services/piper-tts/railway.toml` | `/info` | 5000 | none |
| smartping-voice-stream-e2e | repo root | `railway/app.railway.toml` | `/healthz` | `$PORT` | staging app only |

Note: `speech-e2e` was created as an empty environment, so the production
`smartping-voice-stream` service instance is not present there. Phase 4E.1 uses
`smartping-voice-stream-e2e` in `speech-e2e` (same app image/config). Sync the
production service into `speech-e2e` later if a single service name is required.

**Environment:** `speech-e2e`  
**Project:** `ai-call-center-stream`

Deploy order: STT → Kokoro → Piper → app.

## Private networking

```env
STT_STREAM_URL=ws://speech-to-text.railway.internal:8000/v1/stream
KOKORO_BASE_URL=http://kokoro-tts.railway.internal:8880
PIPER_BASE_URL=http://piper-tts.railway.internal:5000
```

Shared `STT_SERVICE_TOKEN` on app + STT (never printed). Do not substitute public URLs.

## Live-call safeguards

```env
SMARTPING_DRY_RUN=true
SMARTPING_LIVE_CALLS_ENABLED=false
SMARTPING_SINGLE_CALL_ENABLED=false
OUTBOUND_DIALER_LIVE=false
CALL_PROVIDER=mock
```

```bash
npm run verify:non-live
```

## Real-audio simulator

```bash
npm run simulate:local-speech -- --mode audio --language en --scenario send_details
npm run simulate:local-speech -- --mode audio --language te --scenario callback
```

`inject` mode remains for unit/logic tests. `audio` mode:

1. Never calls `/api/speech/inject-transcript`
2. Builds synthetic (or `--input-wav` consented) μ-law via private Kokoro/Piper
3. Paces 160-byte / 20 ms SmartPing `media` frames
4. Observes turn via `/api/speech/session-turn` (non-live only)
5. Asserts Faster-Whisper transcript, intent, TTS provider/voice, μ-law bot audio
6. Reports `telephoneCalls: 0`

Fixture helper (run on private network):

```bash
node scripts/generate-synthetic-caller-fixture.mjs --language en --text "..." --out /tmp/caller.ulaw
```

## Expected provider routing

| Language | STT | Engine | TTS | Voice |
|----------|-----|--------|-----|-------|
| English | Faster-Whisper | deterministic | `kokoro-local` | `af_bella` |
| Telugu | Faster-Whisper | deterministic | `piper-local` | `te_IN-padmavathi-medium` |

Telugu recognition is evaluated on intent + keyword recall, not byte-identical transcripts.
Synthetic Piper→Whisper accuracy ≠ real-human Telugu accuracy.

## Rollback

```env
VOICE_CONVERSATION_ENABLED=false
VOICE_INTERACTION_MODE=dtmf
VOICE_STT_PROVIDER=mock
VOICE_TTS_PROVIDER=mock
OUTBOUND_TTS_PROVIDER=inherit
```

## Operational results

_Filled during bring-up. Do not mark Phase 4E.1 complete until every acceptance gate passes._

| Gate | Result |
|------|--------|
| STT healthy + `/readyz` | pending |
| Kokoro healthy + `af_bella` | pending |
| Piper healthy + Padmavathi | pending |
| App readiness green | pending |
| EN/TE real-audio scenarios | pending |
| ≥10 EN + ≥10 TE latency runs | pending |
| Failure tests | pending |
| Public domains on speech services = 0 | pending |
| `telephoneCalls` = 0 | pending |
| Non-live verifier | pending |

### Image sizes / startup

| Service | Image size | Startup duration | Notes |
|---------|------------|------------------|-------|
| speech-to-text | TBD | TBD | Confirm bake in build logs |
| piper-tts | TBD | TBD | Confirm bake in build logs |
| kokoro-tts | pinned v0.7.0 | TBD | |

### Latency (placeholder)

Separate English (Kokoro) and Telugu (Piper). Label cold vs warm.

## Remaining blockers for a telephone call

1. Complete all Phase 4E.1 acceptance gates above
2. Consented sandbox number + SmartPing sandbox review (Phase 4F)
3. Explicit human approval to open live-call gates

## Go / no-go for Phase 4F

**No-go** until every gate in §2 of the Phase 4E.1 brief is green.
