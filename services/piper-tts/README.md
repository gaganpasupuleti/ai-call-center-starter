# Piper Telugu TTS service (Phase 4D)

Isolated CPU-only HTTP service for Telugu speech synthesis. Runs
[`piper-tts[http]==1.5.0`](https://github.com/OHF-Voice/piper1-gpl) (GPL-3.0-or-later).

**Do not copy Piper source into the Node.js application.** The app talks to this
service over Railway private networking only.

## Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/info` | Server / voice info |
| GET | `/voices` | Available voices |
| POST | `/synthesize` | JSON `{ text, voice?, length_scale? }` → WAV |

## Approved voices

| Voice | Role |
|-------|------|
| `te_IN-padmavathi-medium` | Default / female |
| `te_IN-venkatesh-medium` | Male option |

Do **not** use `te_IN-maya-medium` in this phase.

Each voice requires:

- `<voice>.onnx`
- `<voice>.onnx.json`
- `MODEL_CARD` (dataset licence on the card — currently CC-BY-4.0 for IndicVoices)

## Download models

```bash
python scripts/download_voices.py --dest models --revision main
python scripts/verify_models.py --dest models --require-all
```

Large ONNX files are **not** committed. Bake them at image build time:

```bash
docker build --build-arg DOWNLOAD_VOICES=true -t codequest-piper-tts .
```

Or mount a volume at `/models`.

## Run

```bash
docker build -t codequest-piper-tts .
docker run --rm -p 5000:5000 -v "$(pwd)/models:/models" codequest-piper-tts
```

Default listen port: `${PORT:-5000}`.

## Licence note

- Piper runtime: GPL-3.0-or-later (separate service)
- Voice datasets: see each `MODEL_CARD` (Padmavathi / Venkatesh: CC-BY-4.0 via IndicVoices)
- Attribution: see `THIRD_PARTY_NOTICES.md` and `notices/`
