"""WebSocket JSON protocol helpers for the STT service."""

from __future__ import annotations

from typing import Any


SUPPORTED_LANGUAGES = {"en", "te", "auto"}
SUPPORTED_ENCODINGS = {"mulaw"}


class ProtocolError(ValueError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def parse_start_message(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ProtocolError("invalid_start", "Start message must be a JSON object.")
    if payload.get("type") != "start":
        raise ProtocolError("invalid_start", "First message type must be start.")

    stream_sid = payload.get("streamSid")
    call_sid = payload.get("callSid")
    language = str(payload.get("language") or "en").strip().lower()
    encoding = str(payload.get("encoding") or "mulaw").strip().lower()
    sample_rate = int(payload.get("sampleRate") or 8000)
    channels = int(payload.get("channels") or 1)

    if not stream_sid or not isinstance(stream_sid, str):
        raise ProtocolError("invalid_start", "streamSid is required.")
    if language not in SUPPORTED_LANGUAGES:
        raise ProtocolError("invalid_start", "language must be en, te, or auto.")
    if encoding not in SUPPORTED_ENCODINGS:
        raise ProtocolError("invalid_start", "encoding must be mulaw.")
    if sample_rate != 8000:
        raise ProtocolError("invalid_start", "sampleRate must be 8000.")
    if channels != 1:
        raise ProtocolError("invalid_start", "channels must be 1.")

    return {
        "type": "start",
        "streamSid": stream_sid,
        "callSid": call_sid if isinstance(call_sid, str) else None,
        "language": language,
        "encoding": encoding,
        "sampleRate": sample_rate,
        "channels": channels,
    }


def ready_event(stream_sid: str, sample_rate: int = 8000, vad_window: int = 256) -> dict:
    return {
        "type": "ready",
        "streamSid": stream_sid,
        "sampleRate": sample_rate,
        "vadWindowSamples": vad_window,
    }


def speech_started_event(stream_sid: str, timestamp_ms: int) -> dict:
    return {
        "type": "speech_started",
        "streamSid": stream_sid,
        "timestampMs": int(timestamp_ms),
    }


def speech_ended_event(
    stream_sid: str,
    utterance_duration_ms: int,
    finalize_reason: str | None = None,
) -> dict:
    body = {
        "type": "speech_ended",
        "streamSid": stream_sid,
        "utteranceDurationMs": int(utterance_duration_ms),
    }
    if finalize_reason:
        body["finalizeReason"] = str(finalize_reason)
    return body


def transcript_event(
    *,
    stream_sid: str,
    text: str,
    language: str,
    language_probability: float | None,
    audio_duration_ms: int,
    inference_duration_ms: int,
) -> dict:
    return {
        "type": "transcript",
        "streamSid": stream_sid,
        "text": text,
        "language": language,
        "languageProbability": language_probability,
        "isFinal": True,
        "audioDurationMs": int(audio_duration_ms),
        "inferenceDurationMs": int(inference_duration_ms),
        "provider": "faster-whisper",
    }


def no_speech_event(stream_sid: str, reason: str = "empty_transcript") -> dict:
    return {
        "type": "no_speech",
        "streamSid": stream_sid,
        "reason": reason,
    }


def error_event(code: str, message: str, retryable: bool = True) -> dict:
    return {
        "type": "error",
        "code": code,
        "retryable": bool(retryable),
        "message": message,
    }


def pong_event() -> dict:
    return {"type": "pong"}
