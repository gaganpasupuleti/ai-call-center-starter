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

## Results (fill during Railway battery)

| Gate | Result |
|------|--------|
| C — STT + mock TTS | TBD |
| D — Piper EN 20/20 c1 | TBD |
| D — Piper TE 20/20 c1 | TBD |
| E — full English local-cpu | TBD |
| F — full Telugu | TBD |
| Failure drills | TBD |

## Go / no-go for Phase 4F

**NO-GO** until Gates C–F and failure drills pass on `speech-e2e`.
