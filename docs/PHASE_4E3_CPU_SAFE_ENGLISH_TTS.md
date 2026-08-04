# Phase 4E.3 — CPU-safe English TTS and final end-to-end acceptance

## Summary

Kokoro on the current Railway CPU takes approximately **70–110 seconds** per short
English synthesis request (`kokoro_cpu_runtime_accepted = false`). That latency
exceeds any live-call budget, so English conversational TTS now uses **Piper**
(`en_US-libritts_r-medium`) under `VOICE_TTS_PROVIDER=local-cpu`.

```text
Caller audio → Silero VAD → Faster-Whisper → deterministic engine
  → English: Piper en_US-libritts_r-medium (+ speaker_id)
  → Telugu:  Piper te_IN-padmavathi-medium
  → G.711 μ-law 8 kHz
```

Kokoro remains available only for optional offline catalog generation / quality
comparison. It is **not** required for `local-cpu` readiness.

## English Piper voice

| Field | Value |
|-------|--------|
| Voice | `en_US-libritts_r-medium` |
| Language | en_US |
| Quality | medium |
| Sample rate | 22050 Hz |
| Speakers | 904 |
| Dataset licence | **CC BY 4.0** (LibriTTS-R / OpenSLR 141) |
| HF revision | `9f967d15e9ccdf43078586d1476ee70f314401bd` |
| Model SHA-256 | `10bb85e071d616fcf4071f369f1799d0491492ab3c5d552ec19fb548fac13195` |
| Config SHA-256 | `b471dc60d2d8335e819c393d196d6fbf792817f40051257b269878505bc9afb3` |
| MODEL_CARD SHA-256 | `0ccde6927e5bb4d743f4ea39618a9387ba18cca3351220a8a9cfdbc68b30fcb9` |

Default speaker ID: **0** (automated candidate pick among `{0,25,50,100,200}`;
**not** a human listening approval). Override with `PIPER_ENGLISH_SPEAKER_ID`.

## Provider modes

| Mode | English | Telugu | Kokoro required? |
|------|---------|--------|------------------|
| `mock` | mock | mock | no |
| `local-cpu` | Piper EN | Piper TE | **no** |
| `local-quality` / legacy `local` | Kokoro | Piper TE | yes |
| `precomputed-local` | catalog → else Piper | catalog → else Piper | no |
| `kokoro` | Kokoro | — | yes |
| `piper` | Piper | Piper | no |

Staging acceptance:

```env
VOICE_TTS_PROVIDER=local-cpu
TTS_REQUEST_TIMEOUT_MS=10000
TTS_MAX_CONCURRENT_SYNTHESIS=1
PIPER_ENGLISH_VOICE=en_US-libritts_r-medium
PIPER_ENGLISH_SPEAKER_ID=0
```

Repository default remains `VOICE_TTS_PROVIDER=mock`.

## Historical Kokoro CPU result (preserved)

```text
kokoro_cpu_runtime_accepted = false
reason = synthesis_latency_exceeds_live_call_limit
observed_minimum_ms >= 70000
NNPACK = unsupported on Railway CPU image used in speech-e2e
```

Do not re-run the 20× Kokoro acceptance battery on this hardware.

## Optional precomputed catalog

`scripts/build-response-audio-catalog.mjs` can bake static bot replies (Kokoro offline
or Piper). Runtime uses `PRECOMPUTED_AUDIO_*` + volume `/response-audio` when enabled.
Catalog miss falls back to Piper — never to cloud TTS and never auto-Kokoro in CPU mode.

## Results (speech-e2e Railway battery)

| Gate | Result |
|------|--------|
| C — STT + mock TTS | **PASS** (EN 5/5, TE 4/4; mock-tts; `telephoneCalls=0`) |
| D — Piper EN 20/20 c1 | **PASS** (warm p95 ≈ 1.1 s; hard timeout 10 s) |
| D — Piper TE 20/20 c1 | **PASS** (warm p95 ≈ 1.0 s) |
| D — Kokoro CPU | **not required** (`kokoro_cpu_runtime_accepted=false`) |
| E — full English local-cpu | **PASS** (10/10; `piper-local` / `en_US-libritts_r-medium`) |
| F — full Telugu local-cpu | **PASS** (10/10; `piper-local` / `te_IN-padmavathi-medium`) |
| Failure drills | **PASS** (STT down, Piper down, rollback; unit coverage for speaker/queue/late results) |

### Gate C transcripts (representative)

English: course details → `SEND_DETAILS`; call me back → `CALLBACK`; I do not want it → `NOT_INTERESTED`; do not call me again → `DO_NOT_CALL`; Human AIDS. → `HUMAN_AGENT` (ASR quirk, intent OK).

Telugu sessions (English ASR fixtures + `language=te`): send details / call tomorrow / I do not want it / do not call me → expected intents.

### Latency (post Gate E/F readiness sample)

| Metric | Observed |
|--------|----------|
| STT p95 | ≈ 956 ms |
| Piper TTS p95 | ≈ 1763 ms (under 5 s) |
| Turn p95 | ≈ 3429 ms (under 12 s speech-end→bot budget) |
| Response engine | deterministic; sub-100 ms class locally |

### Failure drills

| Drill | Result |
|-------|--------|
| STT unavailable | App `/healthz` ok; readiness `ready=false`, STT unreachable; no cloud fallback; restored |
| Piper unavailable | App healthy; both EN/TE Piper unreachable; Kokoro optional still up but **not** auto-selected; restored |
| Invalid speaker ID | Unit: `piper_speaker_not_allowed` |
| Late transcript / late TTS / queue full | Covered by existing conversation + TTS unit tests |
| Rollback (`VOICE_CONVERSATION_ENABLED=false`, mock STT/TTS, DTMF) | App starts; speech optional; restored to `local-cpu` |

### Kokoro disposition

Keep deployed as **optional** on speech-e2e for offline catalog / quality work. Not required for `local-cpu` readiness. Not approved for conversational runtime on current Railway CPU. May be stopped later to save resources.

## Go / no-go for Phase 4F

**GO** for Phase 4F planning on the `local-cpu` path (Gates C–F + drills + rollback verified on `speech-e2e`).

Remaining non-blockers: optional precomputed catalog volume not enabled; Gate E battery does not always surface `speakerId` in the JSON summary (config `PIPER_ENGLISH_SPEAKER_ID=0`); human listening QA of LibriTTS speaker 0 not claimed.
