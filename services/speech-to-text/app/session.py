"""Per-WebSocket call session: decode → VAD → transcribe → emit events."""

from __future__ import annotations

import logging
from typing import Any, Awaitable, Callable

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
        # Safe per-connection diagnostics (no audio samples stored).
        self.diagnostics: dict[str, Any] = {
            "mulawBytesReceived": 0,
            "pcmSamplesDecoded": 0,
            "vadWindowsProcessed": 0,
            "speechStartedCount": 0,
            "utterancesFinalized": 0,
            "lastFinalizeReason": None,
            "lastUtteranceDurationMs": None,
            "lastSilenceMs": None,
            "transcriptionsStarted": 0,
            "transcriptionsCompleted": 0,
            "emptyTranscripts": 0,
        }

    def snapshot_diagnostics(self) -> dict[str, Any]:
        """Return a copy of safe counters (never includes audio)."""
        return dict(self.diagnostics)

    async def push_mulaw(self, data: bytes) -> None:
        if self.closed or not data:
            return
        self.diagnostics["mulawBytesReceived"] += len(data)
        samples = mulaw_bytes_to_float32(data)
        self.diagnostics["pcmSamplesDecoded"] += int(samples.size)
        # Approximate windows from segmenter remainder math after push.
        before_total = self.segmenter.total_samples
        events = self.segmenter.push_float_samples(samples)
        after_total = self.segmenter.total_samples
        windows = max(0, (after_total - before_total) // max(1, self.segmenter.window_samples))
        self.diagnostics["vadWindowsProcessed"] += windows
        logger.info(
            "stt_audio_received streamSid=%s mulawBytes=%s pcmSamples=%s vadWindows=%s",
            self.stream_sid,
            len(data),
            int(samples.size),
            windows,
        )
        await self._handle_events(events)

    async def stop(self) -> None:
        if self.closed:
            return
        events = self.segmenter.force_finalize(reason="stop")
        await self._handle_events(events)
        self.closed = True
        logger.info(
            "stt_session_diagnostics streamSid=%s %s",
            self.stream_sid,
            self.snapshot_diagnostics(),
        )

    async def _handle_events(self, events) -> None:
        for event in events:
            if event.kind == "speech_started":
                self.diagnostics["speechStartedCount"] += 1
                logger.info(
                    "stt_speech_started streamSid=%s count=%s",
                    self.stream_sid,
                    self.diagnostics["speechStartedCount"],
                )
                await self.emit(
                    speech_started_event(self.stream_sid, event.timestamp_ms)
                )
            elif event.kind == "discarded":
                self.diagnostics["utterancesFinalized"] += 1
                self.diagnostics["lastFinalizeReason"] = event.reason or "too_short"
                self.diagnostics["lastUtteranceDurationMs"] = event.duration_ms
                self.diagnostics["lastSilenceMs"] = event.silence_ms
                logger.info(
                    "stt_utterance_discarded streamSid=%s reason=%s durationMs=%s",
                    self.stream_sid,
                    event.reason,
                    event.duration_ms,
                )
                await self.emit(
                    no_speech_event(self.stream_sid, reason=event.reason or "too_short")
                )
            elif event.kind == "utterance_ready":
                self.diagnostics["utterancesFinalized"] += 1
                self.diagnostics["lastFinalizeReason"] = event.reason or "silence"
                self.diagnostics["lastUtteranceDurationMs"] = event.duration_ms
                self.diagnostics["lastSilenceMs"] = event.silence_ms
                logger.info(
                    "stt_utterance_finalized streamSid=%s reason=%s durationMs=%s silenceMs=%s",
                    self.stream_sid,
                    event.reason,
                    event.duration_ms,
                    event.silence_ms,
                )
                await self.emit(
                    speech_ended_event(
                        self.stream_sid,
                        event.duration_ms,
                        finalize_reason=event.reason or "silence",
                    )
                )
                await self._transcribe(event.samples, event.duration_ms)

    async def _transcribe(self, samples: np.ndarray | None, duration_ms: int) -> None:
        if samples is None or samples.size == 0:
            self.diagnostics["emptyTranscripts"] += 1
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
        self.diagnostics["transcriptionsStarted"] += 1
        logger.info(
            "stt_transcription_started streamSid=%s durationMs=%s",
            self.stream_sid,
            duration_ms,
        )
        try:
            result = await self.transcriber.transcribe(
                samples,
                language=self.language,
                sample_rate=self.segmenter.sample_rate,
            )
            text = (result.text or "").strip()
            if not text:
                self.diagnostics["emptyTranscripts"] += 1
                logger.info(
                    "stt_empty_transcript streamSid=%s",
                    self.stream_sid,
                )
                await self.emit(
                    no_speech_event(self.stream_sid, reason="empty_transcript")
                )
                return
            lang = result.language or (self.language if self.language != "auto" else "en")
            self.diagnostics["transcriptionsCompleted"] += 1
            logger.info(
                "stt_transcript_emitted streamSid=%s language=%s chars=%s inferenceMs=%s",
                self.stream_sid,
                lang,
                len(text),
                getattr(result, "inference_duration_ms", None),
            )
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
