# Phase 4E — End-to-end local speech and Railway staging

Integrates the completed stack:

```text
SmartPing-compatible WebSocket simulator
→ G.711 μ-law 8 kHz
→ Silero VAD → Faster-Whisper (when enabled)
→ deterministic response engine
→ language router (English → Kokoro, Telugu → Piper)
→ G.711 μ-law 8 kHz response
```

Defaults remain safe:

```env
VOICE_CONVERSATION_ENABLED=false
VOICE_INTERACTION_MODE=dtmf
VOICE_STT_PROVIDER=mock
VOICE_TTS_PROVIDER=mock
SMARTPING_LIVE_CALLS_ENABLED=false
```

## Conversation lifecycle

Per-session `metadata.voiceLifecycle` (separate from dialog `conversationState`):

`connecting` → `greeting_queued` → `greeting_playing` → `listening` →
`speech_detected` → `transcribing` → `deciding` → `synthesizing` →
`response_queued` → `speaking` → `waiting_for_next_turn` / `listening` →
`completed` / `closed`

Helpers: `transitionConversation`, `canAcceptCallerAudio`, `canProcessTranscript`,
`isBotSpeaking`, `completeConversation`.

With `VOICE_IGNORE_INPUT_WHILE_SPEAKING=true`, caller media is not forwarded to STT
while the bot greeting or response is playing (no barge-in in this phase).

## Interaction modes

| Mode | Behaviour |
|------|-----------|
| `dtmf` | Keypad-only (legacy) |
| `voice` | Spoken turns; polite close on second listen timeout |
| `voice-dtmf` | Speech first; DTMF fallback on second timeout / engine action |

## Simulator

```bash
npm run simulate:local-speech -- --language en --scenario send_details
npm run simulate:local-speech -- --language te --scenario callback
```

Uses `/api/speech/inject-transcript` in non-live mode. Synthetic caller audio is
temporary μ-law; inject does **not** prove real-human STT accuracy.

## Health vs readiness

- `/healthz` — process health (deploy healthcheck)
- `/api/speech/readiness` — dependency readiness (no private URLs)
- `/api/speech/metrics` — safe aggregate counters

## Railway layout (`speech-e2e`)

Four services in one non-production environment:

| Service | Public | Config |
|---------|--------|--------|
| call-center-app | yes | `railway/app.railway.toml` |
| speech-to-text | **no** | `railway/stt.railway.toml` |
| kokoro-tts | **no** | pinned image `ghcr.io/remsky/kokoro-fastapi-cpu:v0.7.0` |
| piper-tts | **no** | `railway/piper.railway.toml` |

Internal DNS examples:

```text
ws://speech-to-text.railway.internal:8000/v1/stream
http://kokoro-tts.railway.internal:8880
http://piper-tts.railway.internal:5000
```

Deploy order: STT → Kokoro → Piper → app.

Staging variables (speech-e2e only): see `.env.example` comments and section below.
Keep production SmartPing live flags **false**. Do not print `STT_SERVICE_TOKEN`.

### Suggested resource ceilings

- app: 1 vCPU / 1 GB
- STT: 4 vCPU / 4 GB
- Kokoro: 4 vCPU / 4 GB
- Piper: 2 vCPU / 2 GB
- Max simultaneous test conversations: **2**
- Serverless sleeping **OFF** for STT/Kokoro/Piper during latency measurements

## Rollback

```env
VOICE_CONVERSATION_ENABLED=false
VOICE_INTERACTION_MODE=dtmf
VOICE_STT_PROVIDER=mock
VOICE_TTS_PROVIDER=mock
OUTBOUND_TTS_PROVIDER=inherit
```

DTMF-only flow remains functional without deleting services.

## Known limitations

- Synthetic inject / TTS-as-caller fixtures ≠ human recognition accuracy
- CPU TTS/STT latency varies on Railway
- Healthchecks are startup-only, not continuous monitoring
- Phase 4F is the first controlled consented live SmartPing sandbox call

## Next phase

Phase 4F — Controlled consented SmartPing sandbox call and production-readiness review.
Do not begin Phase 4F from this document alone.
