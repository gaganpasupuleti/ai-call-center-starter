"""Per-WebSocket call session: decode → VAD → transcribe → emit events."""

from __future__ import annotations

import logging
from typing import Awaitable, Callable

import numpy as np

from .mulaw import mulaw_bytes_to_float32
from .protocol import (
    error_event,
    no_speech_event,
    speech_ended_event,
    speech_started_event,
    transcript_event,
)
from .vad import SpeechSegmenter

logger = logging.getLogger("speech-to-text.session")

EmitFn = Callable[[dict], Awaitable[None]]


class StreamSession:
    def __init__(
        self,
        *,
        stream_sid: str,
        call_sid: str | None,
        language: str,
        segmenter: SpeechSegmenter,
        transcriber,
        emit: EmitFn,
    ) -> None:
        self.stream_sid = stream_sid
        self.call_sid = call_sid
        self.language = language
        self.segmenter = segmenter
        self.transcriber = transcriber
        self.emit = emit
        self.closed = False
        self.transcribing = False

    async def push_mulaw(self, data: bytes) -> None:
        if self.closed or not data:
            return
        samples = mulaw_bytes_to_float32(data)
        await self._handle_events(self.segmenter.push_float_samples(samples))

    async def stop(self) -> None:
        if self.closed:
            return
        events = self.segmenter.force_finalize(reason="stop")
        await self._handle_events(events)
        self.closed = True

    async def _handle_events(self, events) -> None:
        for event in events:
            if event.kind == "speech_started":
                await self.emit(
                    speech_started_event(self.stream_sid, event.timestamp_ms)
                )
            elif event.kind == "discarded":
                await self.emit(
                    no_speech_event(self.stream_sid, reason=event.reason or "too_short")
                )
            elif event.kind == "utterance_ready":
                await self.emit(
                    speech_ended_event(self.stream_sid, event.duration_ms)
                )
                await self._transcribe(event.samples, event.duration_ms)

    async def _transcribe(self, samples: np.ndarray | None, duration_ms: int) -> None:
        if samples is None or samples.size == 0:
            await self.emit(no_speech_event(self.stream_sid, reason="empty_transcript"))
            return
        if self.transcribing:
            # One transcription at a time per connection; drop overlapping finalize.
            await self.emit(
                error_event(
                    "transcription_busy",
                    "A transcription is already in progress for this call.",
                    retryable=True,
                )
            )
            return
        self.transcribing = True
        try:
            result = await self.transcriber.transcribe(
                samples,
                language=self.language,
                sample_rate=self.segmenter.sample_rate,
            )
            text = (result.text or "").strip()
            if not text:
                await self.emit(
                    no_speech_event(self.stream_sid, reason="empty_transcript")
                )
                return
            lang = result.language or (self.language if self.language != "auto" else "en")
            await self.emit(
                transcript_event(
                    stream_sid=self.stream_sid,
                    text=text[:2000],
                    language=lang,
                    language_probability=result.language_probability,
                    audio_duration_ms=result.audio_duration_ms or duration_ms,
                    inference_duration_ms=result.inference_duration_ms,
                )
            )
        except Exception:
            logger.exception("transcription_failed streamSid=%s", self.stream_sid)
            await self.emit(
                error_event(
                    "transcription_failed",
                    "Transcription could not be completed.",
                    retryable=True,
                )
            )
        finally:
            self.transcribing = False
