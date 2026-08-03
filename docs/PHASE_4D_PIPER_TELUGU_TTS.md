# Phase 4D — Self-hosted Piper Telugu TTS

Completes the local speech stack:

```text
SmartPing telephone audio
→ Silero VAD
→ Faster-Whisper STT
→ deterministic response engine
→ local language-aware TTS router
   ├── English → Kokoro
   └── Telugu → Piper
→ G.711 μ-law 8 kHz
→ SmartPing
```

## Piper package

| Item | Value |
|------|-------|
| Repository | [OHF-Voice/piper1-gpl](https://github.com/OHF-Voice/piper1-gpl) |
| Package | `piper-tts[http]==1.5.0` |
| Licence | GPL-3.0-or-later |
| Runtime | Separate CPU-only Railway service under `services/piper-tts/` |

Piper source is **not** copied into the Node.js application. The app calls Piper over HTTP on Railway private networking.

### HTTP endpoints

- `GET /info`
- `GET /voices`
- `POST /synthesize` with JSON `{ text, voice?, length_scale? }` → WAV

## Telugu voices

| Voice | Role |
|-------|------|
| `te_IN-padmavathi-medium` | Default / female |
| `te_IN-venkatesh-medium` | Male option |

`te_IN-maya-medium` is **not** used in this phase.

### Model-card licences (inspected 2026-08-03)

Both MODEL_CARD files state:

- Dataset: [ai4bharat/indicvoices_r](https://huggingface.co/datasets/ai4bharat/indicvoices_r)
- Licence: **CC-BY-4.0**
- Sample rate: 22,050 Hz
- Trained by: https://github.com/PravalX

MODEL_CARD SHA-256 (inspected copies under `services/piper-tts/notices/`):

- Padmavathi: `8cdccd0ca4c26d1e949431f03180bcf9eaeb3c013f627087c6a806a3f7487b07`
- Venkatesh: `1e72b79b6453653bd6c43722f80fb34f429dbeccaf18116480d6faa20b01e685`

ONNX / config SHA-256 recorded from `download_voices.py` against Hugging Face `main` (2026-08-03):

| Voice | File | SHA-256 |
|-------|------|---------|
| padmavathi | `.onnx` | `414aa5960d91ceb6e45bbdf8c27fdc71af09f205130d7be4e99470f3c2cfa57d` |
| padmavathi | `.onnx.json` | `6c86e4ee99d379815f78a75f23cdad62ccf50370062dd915c233d6e22de7109f` |
| venkatesh | `.onnx` | `dfaa5b7833cd48d946f3fe18c9c934aaa4e8590aac6922fddf34783a694c3c87` |
| venkatesh | `.onnx.json` | `59bad556763d1f24b3434201d7bdee275bb1a70db3e1c65d38e6c3d39b224343` |

Do not infer licences only from the Hugging Face repo label.

Attribution: see `services/piper-tts/THIRD_PARTY_NOTICES.md` and root `THIRD_PARTY_NOTICES.md`.

## Speed mapping

Application `speed` → Piper `length_scale = 1 / speed` (clamped).

## WAV → μ-law

Piper returns WAV (native rate, typically 22050 Hz). Conversion uses `ffmpeg-static` with fixed args:

```text
-i pipe:0 → -ar 8000 -ac 1 -f mulaw pipe:1
```

No temp files; spawn only.

## Provider modes

| `VOICE_TTS_PROVIDER` | Behaviour |
|----------------------|-----------|
| `mock` | All languages use mock TTS (default) |
| `local` | English → Kokoro, Telugu → Piper |
| `kokoro` | English-only Kokoro |
| `piper` | Telugu-only Piper |

`OUTBOUND_TTS_PROVIDER=inherit` follows the main provider. Supported outbound values: `inherit`, `mock`, `local`, `kokoro`, `piper`.

**Microsoft Edge online TTS is removed.** `msedge` / `edge` fail startup with a migration error. There is no automatic cloud fallback.

## Cache and concurrency

Reuses Phase 4C bounded cache (key includes provider + language + voice + speed + text + format version) and concurrency limits. Optional `PIPER_MAX_CONCURRENT_SYNTHESIS`.

## Health

Safe combined status (no private URLs):

```json
{
  "mode": "local",
  "providers": {
    "english": { "provider": "kokoro", "configured": true, "reachable": true, "voice": "af_bella" },
    "telugu": { "provider": "piper", "configured": true, "reachable": true, "voice": "te_IN-padmavathi-medium" }
  }
}
```

## Local smoke test

```bash
npm run test:piper-local
```

## Safe Railway activation order

1. Deploy Kokoro privately.
2. Deploy Piper privately.
3. Verify Piper `/info` and `/voices`.
4. Run English Kokoro smoke test.
5. Run Telugu Piper smoke test.
6. Keep `VOICE_TTS_PROVIDER=mock`.
7. Test local router using fake transcripts.
8. Set `VOICE_TTS_PROVIDER=local` in a non-live environment.
9. Verify English → Kokoro.
10. Verify Telugu → Piper.
11. Keep SmartPing live-call flags disabled.
12. Perform controlled simulator testing.

Do not enable live SmartPing calls in this phase.

## Known limitations

- CPU-only synthesis; latency grows with utterance length and concurrent calls.
- Telugu pronunciation quality depends on Piper medium models and IndicVoices training data; expect imperfect names, English loanwords, and rare phrases.
- Large ONNX files must be downloaded or volume-mounted; they are not committed.

## Phase 4E boundary

Next: end-to-end local speech integration, Railway deployment, and controlled simulator validation. Do not start Phase 4E from this document alone without an explicit task.
