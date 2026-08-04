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

_Updated during bring-up. Phase 4E.1 acceptance is **not** complete until every gate is green._

| Gate | Result |
|------|--------|
| STT healthy + `/readyz` | **pass** — Whisper Small + Silero ONNX baked (`whisper_ok`, `silero_copied_from_package`) |
| Kokoro healthy + `af_bella` | **pass** (intermittent CPU timeouts under concurrent fixture load) |
| Piper healthy + Padmavathi | **pass** — voices baked at revision `9f967d15…`, hashes verified |
| App readiness green | **pass** when Kokoro reachable (`mode=local`, all three services ready) |
| EN/TE real-audio scenarios | **blocked** — EN fixture generation hits Kokoro request timeouts; TE audio frames send but transcript often null before listening/STT settle |
| ≥10 EN + ≥10 TE latency runs | **blocked** on scenario success above |
| Failure tests | **partial** — non-live verifier + offline unit tests pass; live dependency failure drills incomplete |
| Public domains on speech services = 0 | **pass** |
| `telephoneCalls` = 0 | **pass** (safeguards + simulator contract) |
| Non-live verifier | **pass** (`npm run verify:non-live`) |

### Image sizes / startup

| Service | Image size | Startup duration | Notes |
|---------|------------|------------------|-------|
| speech-to-text | large (torch + small Whisper) | model load logged `whisper_ready` | Bake confirmed in build logs |
| piper-tts | ~two 63.5 MB ONNX voices | `/info` 200 after start | Hash OK for both voices |
| kokoro-tts | pinned `v0.7.0` | voices endpoint OK when healthy | CPU contention under hobby concurrency |

### Deploy notes

- Empty `speech-e2e` environment required a separate app service: `smartping-voice-stream-e2e`
- Speech Docker services deploy via `railway up ./services/<name> --path-as-root` with in-service `railway.toml`
- Private runner: `speech-test-runner` (no public domain) executes `scripts/run-phase4e1-audio-battery.mjs`
- SSH into containers was unreliable from this agent environment

### Latency (placeholder until successful turns)

Observed STT speech-end→transcript samples while partially healthy: min≈10.4 s, median≈12.1 s, p95≈14.2 s (warm-ish, Kokoro TTS duration not yet measured successfully end-to-end).

## Remaining blockers for a telephone call

1. Stabilize Kokoro under concurrent synthesize (fixture + greeting/response) on Railway CPU — EN real-audio fixtures currently time out
2. Prove TE/EN audio mode turns with non-null Faster-Whisper transcripts and correct TTS routing (≥10 each)
3. Complete failure drills (STT/Kokoro/Piper unavailable) and document results
4. Consented sandbox number + SmartPing sandbox review (Phase 4F)
5. Explicit human approval to open live-call gates

## Go / no-go for Phase 4F

**No-go.** Speech services can be brought up privately and aggregate readiness can go green, but real-audio end-to-end acceptance gates are not all passing.

## Phase 4E.2 follow-up (do not rewrite 4E.1 results above)

Stabilization work continues on branch `phase-4e2-real-audio-stabilization`.
See [PHASE_4E2_REAL_AUDIO_STABILIZATION.md](./PHASE_4E2_REAL_AUDIO_STABILIZATION.md).

Primary code fixes:

* Trailing silence 1200 ms (was ~300 ms) vs `VAD_MIN_SILENCE_MS=800`
* Strict `listening` + `sttStatus=ready` before caller media
* Fixture bank prepared before WebSocket open
* Direct STT gate before full-stack audio
* Kokoro acceptance concurrency default = 1
