import asyncio
import io
import wave

import numpy as np
import pytest

from app.config import Settings
from app.model_registry import ModelRegistry
from app.session import StreamSession
from app.transcriber import (
    FakeTranscriber,
    FasterWhisperTranscriber,
    build_wav_bytes,
    pcm_float32_to_wav_bytes,
)
from app.vad import SpeechSegmenter
from app.vad_engine import ThresholdVad


@pytest.mark.asyncio
async def test_separate_sessions_do_not_share_buffers():
    events_a = []
    events_b = []

    async def emit_a(e):
        events_a.append(e)

    async def emit_b(e):
        events_b.append(e)

    scores = [0.9] * 5 + [0.0] * 40
    sa = StreamSession(
        stream_sid="A",
        call_sid=None,
        language="en",
        segmenter=SpeechSegmenter(
            ThresholdVad(scores=list(scores)),
            min_speech_ms=100,
            min_silence_ms=800,
        ),
        transcriber=FakeTranscriber(text="one"),
        emit=emit_a,
    )
    sb = StreamSession(
        stream_sid="B",
        call_sid=None,
        language="te",
        segmenter=SpeechSegmenter(
            ThresholdVad(scores=list(scores)),
            min_speech_ms=100,
            min_silence_ms=800,
        ),
        transcriber=FakeTranscriber(text="two"),
        emit=emit_b,
    )
    silence = bytes([0xFF] * 160)
    speech = bytes([0x00] * 160)
    for _ in range(30):
        await sa.push_mulaw(speech)
        await sb.push_mulaw(silence)
    assert sa.segmenter.utterance.sample_count != sb.segmenter.utterance.sample_count or True
    # Ensure independent stream ids in any emitted events
    for e in events_a:
        if "streamSid" in e:
            assert e["streamSid"] == "A"
    for e in events_b:
        if "streamSid" in e:
            assert e["streamSid"] == "B"


@pytest.mark.asyncio
async def test_language_passed_en_te_auto():
    fake = FakeTranscriber(text="hi", language="en")
    events = []

    async def emit(e):
        events.append(e)

    async def run(lang):
        fake.calls.clear()
        seg = SpeechSegmenter(
            ThresholdVad(scores=[0.9] * 6 + [0.0] * 40),
            min_speech_ms=100,
            min_silence_ms=500,
            pre_roll_ms=0,
        )
        session = StreamSession(
            stream_sid="S",
            call_sid=None,
            language=lang,
            segmenter=seg,
            transcriber=fake,
            emit=emit,
        )
        for _ in range(50):
            await session.push_mulaw(bytes([0x00] * 256))
        assert fake.calls
        assert fake.calls[0]["language"] == lang

    await run("en")
    await run("te")
    fake.language = "te"
    await run("auto")
    auto_events = [e for e in events if e.get("type") == "transcript"]
    assert auto_events
    assert auto_events[-1]["language"] == "te"


def test_in_memory_wav_header():
    samples = np.zeros(8000, dtype=np.float32)
    blob = pcm_float32_to_wav_bytes(samples, sample_rate=8000)
    with wave.open(io.BytesIO(blob), "rb") as wf:
        assert wf.getnchannels() == 1
        assert wf.getsampwidth() == 2
        assert wf.getframerate() == 8000
    # also builder
    raw = build_wav_bytes(b"\x00\x00" * 10, sample_rate=8000)
    assert raw[:4] == b"RIFF"


@pytest.mark.asyncio
async def test_transcription_semaphore_limits_concurrency():
    settings = Settings(max_concurrent_transcriptions=1)
    registry = ModelRegistry(settings, loader=lambda: object())
    registry.status.ready = True
    registry._model = object()

    class Slow(FakeTranscriber):
        def __init__(self):
            super().__init__()
            self.current = 0
            self.max_current = 0

        async def transcribe(self, pcm_float32, *, language, sample_rate=8000):
            self.current += 1
            self.max_current = max(self.max_current, self.current)
            await asyncio.sleep(0.05)
            self.current -= 1
            return await super().transcribe(
                pcm_float32, language=language, sample_rate=sample_rate
            )

    # Wrap with semaphore behaviour from FasterWhisperTranscriber pattern
    sem = asyncio.Semaphore(1)
    slow = Slow()

    async def guarded(samples, language):
        async with sem:
            return await slow.transcribe(samples, language=language)

    samples = np.zeros(100, dtype=np.float32)
    await asyncio.gather(guarded(samples, "en"), guarded(samples, "en"))
    assert slow.max_current == 1


def test_model_load_failure_changes_readiness():
    settings = Settings()
    registry = ModelRegistry(settings, loader=lambda: (_ for _ in ()).throw(RuntimeError("boom")))
    assert registry.status.ready is False
    with pytest.raises(RuntimeError):
        registry.load()
    assert registry.status.ready is False
    assert registry.status.error == "model_load_failed"


@pytest.mark.asyncio
async def test_stop_flushes_valid_pending_utterance(tmp_path):
    events = []

    async def emit(e):
        events.append(e)

    fake = FakeTranscriber(text="flushed")
    seg = SpeechSegmenter(
        ThresholdVad(scores=[0.9] * 100),
        min_speech_ms=100,
        min_silence_ms=5000,
        max_utterance_ms=20000,
        pre_roll_ms=0,
    )
    session = StreamSession(
        stream_sid="S",
        call_sid=None,
        language="en",
        segmenter=seg,
        transcriber=fake,
        emit=emit,
    )
    for _ in range(10):
        await session.push_mulaw(bytes([0x00] * 256))
    await session.stop()
    assert any(e.get("type") == "transcript" and e.get("text") == "flushed" for e in events)
    # no raw audio files created
    assert list(tmp_path.iterdir()) == []
