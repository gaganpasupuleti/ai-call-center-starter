#!/usr/bin/env python3
"""Manual local file transcription helper (not used in CI)."""

from __future__ import annotations

import argparse
import asyncio
import sys
import wave
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.config import Settings
from app.model_registry import ModelRegistry
from app.transcriber import FasterWhisperTranscriber


def load_wav_float32(path: Path) -> tuple[np.ndarray, int]:
    with wave.open(str(path), "rb") as wf:
        rate = wf.getframerate()
        channels = wf.getnchannels()
        width = wf.getsampwidth()
        frames = wf.readframes(wf.getnframes())
    if width != 2:
        raise SystemExit("Only 16-bit PCM WAV is supported by this helper")
    pcm = np.frombuffer(frames, dtype=np.int16)
    if channels > 1:
        pcm = pcm.reshape(-1, channels).mean(axis=1).astype(np.int16)
    return (pcm.astype(np.float32) / 32768.0).clip(-1.0, 1.0), rate


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--file", required=True)
    parser.add_argument("--language", default="en", choices=["en", "te", "auto"])
    parser.add_argument("--model", default="small")
    parser.add_argument("--download-root", default="./models")
    args = parser.parse_args()

    samples, rate = load_wav_float32(Path(args.file))
    settings = Settings(
        whisper_model=args.model,
        whisper_download_root=args.download_root,
        load_model_on_startup=False,
    )
    registry = ModelRegistry(settings)
    registry.load()
    transcriber = FasterWhisperTranscriber(registry, settings)

    async def run():
        return await transcriber.transcribe(
            samples, language=args.language, sample_rate=rate
        )

    result = asyncio.run(run())
    print(
        {
            "text": result.text,
            "language": result.language,
            "languageProbability": result.language_probability,
            "audioDurationMs": result.audio_duration_ms,
            "inferenceDurationMs": result.inference_duration_ms,
        }
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
