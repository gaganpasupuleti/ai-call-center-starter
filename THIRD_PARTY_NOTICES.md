# Third-party notices

## Kokoro-FastAPI

- Repository: https://github.com/remsky/Kokoro-FastAPI
- Image used in this project: `ghcr.io/remsky/kokoro-fastapi-cpu:v0.7.0`
- License: Apache License 2.0

## Kokoro-82M

- Model used by Kokoro-FastAPI for English speech synthesis
- License: Apache License 2.0

This application does not vendor the Kokoro-FastAPI source tree or redistribute font files. Kokoro runs as a separate container/service.

## Piper (OHF-Voice/piper1-gpl)

- Package: `piper-tts[http]==1.5.0`
- Repository: https://github.com/OHF-Voice/piper1-gpl
- License: GPL-3.0-or-later

Piper runs only as the isolated service under `services/piper-tts/`. The Node.js application does not vendor Piper source.

## Piper Telugu voices (rhasspy/piper-voices)

- Source: https://huggingface.co/rhasspy/piper-voices
- Voices: `te_IN-padmavathi-medium`, `te_IN-venkatesh-medium`
- Per-voice MODEL_CARD (inspected 2026-08-03): dataset [IndicVoices](https://huggingface.co/datasets/ai4bharat/indicvoices_r), licence **CC-BY-4.0**
- See `services/piper-tts/THIRD_PARTY_NOTICES.md` and `services/piper-tts/notices/` for MODEL_CARD copies and hashes

Microsoft Edge online TTS (`msedge-tts`) has been removed from this project.
