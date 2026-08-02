import asyncio

import numpy as np
import pytest

from app.config import Settings
from app.model_registry import ModelRegistry
from app.transcriber import FakeTranscriber, FasterWhisperTranscriber


@pytest.mark.asyncio
async def test_fake_transcriber_english_and_telugu_language_args():
    fake = FakeTranscriber(text="ok")
    samples = np.zeros(1600, dtype=np.float32)
    await fake.transcribe(samples, language="en")
    await fake.transcribe(samples, language="te")
    assert fake.calls[0]["language"] == "en"
    assert fake.calls[1]["language"] == "te"


@pytest.mark.asyncio
async def test_auto_language_returns_detected():
    fake = FakeTranscriber(text="వివరాలు", language="te", probability=0.86)
    result = await fake.transcribe(np.zeros(800, dtype=np.float32), language="auto")
    assert result.language == "te"
    assert result.language_probability == 0.86


@pytest.mark.asyncio
async def test_faster_whisper_transcriber_uses_registry_and_semaphore():
    settings = Settings(max_concurrent_transcriptions=2)

    class DummyModel:
        def transcribe(self, audio, **kwargs):
            class Seg:
                text = "send me the course details"

            class Info:
                language = kwargs.get("language") or "en"
                language_probability = 0.91

            return [Seg()], Info()

    registry = ModelRegistry(settings, loader=lambda: DummyModel())
    registry.load()
    tr = FasterWhisperTranscriber(registry, settings)
    result = await tr.transcribe(np.zeros(1600, dtype=np.float32), language="en")
    assert result.text == "send me the course details"
    assert result.language == "en"
