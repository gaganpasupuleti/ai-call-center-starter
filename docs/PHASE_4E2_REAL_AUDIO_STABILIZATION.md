# Phase 4E.2 — Real-audio stabilization and acceptance-gate recovery

## Summary

Phase 4E.1 identified why real-audio turns failed on Railway `speech-e2e`. This phase
fixes those defects and re-structures acceptance into layered gates (A–F).

**Do not start Phase 4F until every gate below is green.**

## Root cause of missing transcripts (4E.1 historical)

The local-speech simulator previously sent approximately:

```text
15 frames × 20 ms = 300 ms trailing silence
```

while Faster-Whisper STT required:

```text
VAD_MIN_SILENCE_MS=800
```

Utterances therefore never reached `utterance_ready` / `speech_ended`, so
`actualTranscript` stayed null. This was not primarily a model accuracy issue.

Additional blockers from 4E.1:

1. `waitForListening()` accepted weak lifecycle checks and returned on timeout.
2. Caller fixture synthesis competed with Kokoro greeting/response synthesis.
3. Greeting expectations were unclear (`greetingReceived: false` treated as failure).
4. Full-stack audio tests ran before direct STT was proven.

## Fixes in 4E.2

### Trailing silence

Simulator defaults:

```text
SIMULATOR_PRE_ROLL_SILENCE_MS=200
SIMULATOR_TRAILING_SILENCE_MS=1200
```

Frame counts are derived dynamically (`Math.ceil(ms / 20)`), not hard-coded to 15.

### Strict listening / STT readiness

Audio is sent only when:

```text
voiceLifecycle === "listening"
&& sttStarted === true
&& sttStatus === "ready"
```

Timeouts throw `session_not_ready_for_audio` with safe diagnostics only.

### Fixture ordering

Audio mode order:

1. Generate or load caller fixture
2. Validate fixture (peak / RMS / dBFS)
3. Open WebSocket
4. Wait for listening + STT ready
5. Send paced caller audio

### Greeting modes

* `--greeting none` — STT / response isolation; missing greeting is not a failure
* `--greeting prepared` — requires greeting media/completion before listening assertions

### Layered acceptance gates

| Gate | Scope |
|------|--------|
| A | Fixture validation |
| B | Direct STT (bypass app/TTS) |
| C | App STT path + mock TTS |
| D | Direct Kokoro / Piper stability |
| E | Full English turn |
| F | Full Telugu turn |

Do not advance when the current gate fails.

### Media accounting

Session metadata tracks `mediaFramesReceived`, `mediaFramesForwardedToStt`, and
suppression reasons (`bot_speaking`, `not_listening`, `stt_not_ready`, `session_closed`).
Audio mode fails if frames were sent but none were forwarded to STT.

### STT VAD diagnostics

Python STT sessions log safe counters (bytes received, VAD windows, speech starts,
finalize reason, transcription counts) and expose `/v1/diagnostics/last`.

## Stabilization env (speech-e2e)

```env
STT_MAX_CONCURRENT_TRANSCRIPTIONS=1
STT_TRANSCRIPT_TIMEOUT_MS=30000
TTS_MAX_CONCURRENT_SYNTHESIS=1
TTS_MAX_PENDING_REQUESTS=2
TTS_REQUEST_TIMEOUT_MS=30000
VOICE_MAX_TURNS=3
```

## Results (fill during Railway battery)

### Direct STT

| Language | Runs | Success | Fail | Finalize | Notes |
|----------|------|---------|------|----------|-------|
| English  | 10   | TBD     | TBD  | silence  | |
| Telugu   | 10   | TBD     | TBD  | silence  | |

### Kokoro stability

| Concurrency | Requests | Success | Fail | Timeout | p95 |
|-------------|----------|---------|------|---------|-----|
| 1           | 20       | TBD     | TBD  | TBD     | TBD |
| 2           | 10       | TBD     | TBD  | TBD     | TBD |

### Piper stability

| Concurrency | Requests | Success | Fail | p95 |
|-------------|----------|---------|------|-----|
| 1           | TBD      | TBD     | TBD  | TBD |

### Full application turns

| Language | Scenario mix | Transcript | Intent | Provider | μ-law |
|----------|--------------|------------|--------|----------|-------|
| English  | 3+3+2+2      | TBD        | TBD    | kokoro-local / af_bella | TBD |
| Telugu   | 3+3+2+2      | TBD        | TBD    | piper-local / te_IN-padmavathi-medium | TBD |

### Failure drills

| Drill | Result |
|-------|--------|
| STT unavailable | TBD |
| Kokoro unavailable | TBD |
| Piper unavailable | TBD |
| Session closed during transcription | TBD |
| Session closed during synthesis | TBD |
| Pending transcript overflow | TBD |

### Rollback

```env
VOICE_CONVERSATION_ENABLED=false
VOICE_INTERACTION_MODE=dtmf
VOICE_STT_PROVIDER=mock
VOICE_TTS_PROVIDER=mock
OUTBOUND_TTS_PROVIDER=inherit
```

Result: TBD (app starts; speech optional; SmartPing simulator passes; telephoneCalls=0).

## Railway observations

* Project: `ai-call-center-stream` / environment: `speech-e2e` only
* Public domain: `smartping-voice-stream-e2e` only
* Speech services remain private (no public domains)
* CPU / memory / restart counts: record during battery

## Remaining blockers

_List honestly after the battery. Do not average away failed runs._

## Go / no-go for Phase 4F

**Current decision: NO-GO until Gates A–F and failure drills pass.**

Preserve Phase 4E.1 historical failures in
[PHASE_4E1_RAILWAY_BRINGUP.md](./PHASE_4E1_RAILWAY_BRINGUP.md); do not rewrite them.
Append corrected 4E.2 runs here and in the 4E.1 appendix when available.
