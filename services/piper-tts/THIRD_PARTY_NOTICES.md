# Third-party notices — Piper TTS service

## Piper (OHF-Voice/piper1-gpl)

- Package: `piper-tts[http]==1.5.0`
- Repository: https://github.com/OHF-Voice/piper1-gpl
- Licence: GPL-3.0-or-later

This service runs Piper as an isolated process. The proprietary Node.js
application does not vendor Piper source code.

## Telugu voice models (rhasspy/piper-voices)

Source repository: https://huggingface.co/rhasspy/piper-voices  
Inspected revision channel: `main` (MODEL_CARD files fetched 2026-08-03)

### te_IN-padmavathi-medium

- Path: `te/te_IN/padmavathi/medium/`
- Sample rate (model card): 22,050 Hz
- Dataset: https://huggingface.co/datasets/ai4bharat/indicvoices_r
- Dataset licence stated on MODEL_CARD: **CC-BY-4.0**
- Trained by: https://github.com/PravalX
- MODEL_CARD SHA-256 (inspected copy): `8cdccd0ca4c26d1e949431f03180bcf9eaeb3c013f627087c6a806a3f7487b07`
- ONNX SHA-256 (downloaded from HF `main`, 2026-08-03): `414aa5960d91ceb6e45bbdf8c27fdc71af09f205130d7be4e99470f3c2cfa57d`
- Config SHA-256: `6c86e4ee99d379815f78a75f23cdad62ccf50370062dd915c233d6e22de7109f`

### te_IN-venkatesh-medium

- Path: `te/te_IN/venkatesh/medium/`
- Sample rate (model card): 22,050 Hz
- Dataset: https://huggingface.co/datasets/ai4bharat/indicvoices_r
- Dataset licence stated on MODEL_CARD: **CC-BY-4.0**
- Trained by: https://github.com/PravalX
- MODEL_CARD SHA-256 (inspected copy): `1e72b79b6453653bd6c43722f80fb34f429dbeccaf18116480d6faa20b01e685`
- ONNX SHA-256 (downloaded from HF `main`, 2026-08-03): `dfaa5b7833cd48d946f3fe18c9c934aaa4e8590aac6922fddf34783a694c3c87`
- Config SHA-256: `59bad556763d1f24b3434201d7bdee275bb1a70db3e1c65d38e6c3d39b224343`

A full `models/voices.manifest.json` is produced by `scripts/download_voices.py` (gitignored). Do not infer a voice licence only from
the overall Hugging Face repository label; use the per-voice MODEL_CARD.

### en_US-libritts_r-medium (Phase 4E.3 CPU-safe English)

- Path: `en/en_US/libritts_r/medium/`
- Language: en_US
- Quality: medium
- Sample rate (model card): 22,050 Hz
- Speakers: 904 (multi-speaker)
- Dataset: http://www.openslr.org/141/ (LibriTTS-R)
- Dataset licence stated on MODEL_CARD: **CC BY 4.0**
- Source revision (pinned): `9f967d15e9ccdf43078586d1476ee70f314401bd`
- MODEL_CARD SHA-256: `0ccde6927e5bb4d743f4ea39618a9387ba18cca3351220a8a9cfdbc68b30fcb9`
- ONNX SHA-256: `10bb85e071d616fcf4071f369f1799d0491492ab3c5d552ec19fb548fac13195`
- Config SHA-256: `b471dc60d2d8335e819c393d196d6fbf792817f40051257b269878505bc9afb3`
- Attribution: Fine-tuned from English lessac medium on train-clean-360 (per MODEL_CARD)

Copies of the inspected MODEL_CARD text are kept under `notices/` for attribution.
