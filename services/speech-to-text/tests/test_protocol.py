import pytest

from app.protocol import ProtocolError, parse_start_message, ready_event, transcript_event


def test_valid_start_message():
    parsed = parse_start_message(
        {
            "type": "start",
            "streamSid": "MZ1",
            "callSid": "CA1",
            "language": "en",
            "encoding": "mulaw",
            "sampleRate": 8000,
            "channels": 1,
        }
    )
    assert parsed["streamSid"] == "MZ1"
    assert parsed["language"] == "en"


def test_malformed_start_rejected():
    with pytest.raises(ProtocolError):
        parse_start_message({"type": "start"})
    with pytest.raises(ProtocolError):
        parse_start_message({"type": "start", "streamSid": "x", "sampleRate": 16000})
    with pytest.raises(ProtocolError):
        parse_start_message("nope")


def test_ready_and_transcript_shapes():
    ready = ready_event("MZ1")
    assert ready["type"] == "ready"
    assert ready["vadWindowSamples"] == 256
    tr = transcript_event(
        stream_sid="MZ1",
        text="hello",
        language="en",
        language_probability=0.9,
        audio_duration_ms=1000,
        inference_duration_ms=10,
    )
    assert tr["isFinal"] is True
    assert tr["provider"] == "faster-whisper"
