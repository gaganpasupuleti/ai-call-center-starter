import numpy as np

from app.audio_buffer import RingBuffer, SampleRemainder, UtteranceBuffer
from app.vad import SpeechSegmenter
from app.vad_engine import ThresholdVad


def test_160_frames_assemble_into_256_windows_with_remainder():
    rem = SampleRemainder(256)
    frame = np.ones(160, dtype=np.float32)
    w1 = rem.push(frame)
    assert w1 == []
    assert rem.remainder_size == 160
    w2 = rem.push(frame)
    assert len(w2) == 1
    assert w2[0].shape == (256,)
    assert rem.remainder_size == 64
    w3 = rem.push(frame)
    assert len(w3) == 0
    assert rem.remainder_size == 224
    w4 = rem.push(frame)
    assert len(w4) == 1
    assert rem.remainder_size == 128


def test_pre_roll_retained_on_speech_start():
    # Silence scores then speech
    scores = [0.0] * 2 + [0.9] * 10 + [0.0] * 40
    seg = SpeechSegmenter(
        ThresholdVad(scores=scores),
        threshold=0.5,
        min_speech_ms=100,
        min_silence_ms=800,
        pre_roll_ms=200,
        max_utterance_ms=12000,
    )
    events = []
    # 2 silence windows (pre-roll) + speech
    for _ in range(20):
        events.extend(seg.push_float_samples(np.ones(256, dtype=np.float32) * 0.1))
    started = [e for e in events if e.kind == "speech_started"]
    assert len(started) == 1
    # Continue until silence finalizes
    for _ in range(40):
        events.extend(seg.push_float_samples(np.zeros(256, dtype=np.float32)))
    ready = [e for e in events if e.kind == "utterance_ready"]
    assert len(ready) == 1
    assert ready[0].samples is not None
    assert ready[0].samples.size > 256  # includes pre-roll


def test_silence_does_not_produce_utterance():
    seg = SpeechSegmenter(
        ThresholdVad(scores=[0.0] * 50),
        min_speech_ms=250,
        min_silence_ms=800,
    )
    events = []
    for _ in range(30):
        events.extend(seg.push_float_samples(np.zeros(256, dtype=np.float32)))
    assert not any(e.kind == "utterance_ready" for e in events)
    assert not any(e.kind == "speech_started" for e in events)


def test_speech_start_emitted_once():
    scores = [0.9] * 5 + [0.0] * 40
    seg = SpeechSegmenter(
        ThresholdVad(scores=scores),
        min_speech_ms=100,
        min_silence_ms=800,
    )
    events = []
    for _ in range(50):
        events.extend(seg.push_float_samples(np.ones(256, dtype=np.float32) * 0.2))
        if any(e.kind == "utterance_ready" for e in events):
            break
    assert len([e for e in events if e.kind == "speech_started"]) == 1
    assert any(e.kind == "utterance_ready" for e in events)


def test_speech_end_after_configured_silence():
    # speech then long silence
    scores = [0.9] * 4 + [0.0] * 50
    seg = SpeechSegmenter(
        ThresholdVad(scores=scores),
        min_speech_ms=100,
        min_silence_ms=800,
    )
    events = []
    for _ in range(60):
        events.extend(seg.push_float_samples(np.ones(256, dtype=np.float32) * 0.2))
    assert any(e.kind == "utterance_ready" for e in events)


def test_short_speech_discarded():
    scores = [0.9] + [0.0] * 40
    seg = SpeechSegmenter(
        ThresholdVad(scores=scores),
        min_speech_ms=500,
        min_silence_ms=300,
        pre_roll_ms=0,
    )
    events = []
    for _ in range(50):
        events.extend(seg.push_float_samples(np.ones(256, dtype=np.float32) * 0.2))
    assert any(e.kind == "discarded" for e in events)
    assert not any(e.kind == "utterance_ready" for e in events)


def test_max_utterance_forces_finalization():
    scores = [0.9] * 1000
    seg = SpeechSegmenter(
        ThresholdVad(scores=scores),
        min_speech_ms=100,
        min_silence_ms=8000,
        max_utterance_ms=1000,  # ~8 windows at 256/8k
    )
    events = []
    for _ in range(40):
        events.extend(seg.push_float_samples(np.ones(256, dtype=np.float32) * 0.2))
    ready = [e for e in events if e.kind == "utterance_ready"]
    assert ready
    assert ready[0].reason == "max_utterance"


def test_ring_and_utterance_buffers_independent():
    a = UtteranceBuffer()
    b = UtteranceBuffer()
    a.append(np.ones(10, dtype=np.float32))
    assert a.sample_count == 10
    assert b.sample_count == 0
    r = RingBuffer(5)
    r.push(np.arange(8, dtype=np.float32))
    assert len(r) == 5
