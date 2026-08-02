"""Utterance segmentation using Silero (or fake) VAD at 8 kHz / 256 samples."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

import numpy as np

from .audio_buffer import RingBuffer, SampleRemainder, UtteranceBuffer
from .vad_engine import ThresholdVad, VadEngine


EventKind = Literal["speech_started", "utterance_ready", "discarded"]


@dataclass
class SegmentEvent:
    kind: EventKind
    timestamp_ms: int = 0
    samples: np.ndarray | None = None
    duration_ms: int = 0
    reason: str | None = None


class SpeechSegmenter:
    def __init__(
        self,
        vad: VadEngine | None = None,
        *,
        sample_rate: int = 8000,
        window_samples: int = 256,
        threshold: float = 0.50,
        min_speech_ms: int = 250,
        min_silence_ms: int = 800,
        max_utterance_ms: int = 12000,
        pre_roll_ms: int = 200,
        speech_pad_ms: int = 120,
    ) -> None:
        self.vad = vad or ThresholdVad()
        self.sample_rate = sample_rate
        self.window_samples = window_samples
        self.threshold = threshold
        self.min_speech_samples = int(sample_rate * min_speech_ms / 1000)
        self.min_silence_samples = int(sample_rate * min_silence_ms / 1000)
        self.max_utterance_samples = int(sample_rate * max_utterance_ms / 1000)
        self.speech_pad_samples = int(sample_rate * speech_pad_ms / 1000)
        self.pre_roll = RingBuffer(int(sample_rate * pre_roll_ms / 1000))
        self.remainder = SampleRemainder(window_samples)
        self.utterance = UtteranceBuffer()
        self.in_speech = False
        self.speech_started_emitted = False
        self.silence_samples = 0
        self.total_samples = 0
        self.speech_start_sample = 0

    def reset(self) -> None:
        self.vad.reset()
        self.remainder.clear()
        self.pre_roll.clear()
        self.utterance.clear()
        self.in_speech = False
        self.speech_started_emitted = False
        self.silence_samples = 0
        self.total_samples = 0
        self.speech_start_sample = 0

    def push_float_samples(self, samples: np.ndarray) -> list[SegmentEvent]:
        events: list[SegmentEvent] = []
        for window in self.remainder.push(samples):
            events.extend(self._process_window(window))
        return events

    def force_finalize(self, reason: str = "stop") -> list[SegmentEvent]:
        events: list[SegmentEvent] = []
        if self.in_speech and self.utterance.sample_count > 0:
            events.extend(self._finalize(reason=reason))
        self.reset()
        return events

    def _process_window(self, window: np.ndarray) -> list[SegmentEvent]:
        events: list[SegmentEvent] = []
        prob = float(self.vad.probability(window))
        is_speech = prob >= self.threshold
        self.total_samples += int(window.size)
        timestamp_ms = int(1000.0 * self.total_samples / self.sample_rate)

        if not self.in_speech:
            self.pre_roll.push(window)
            if is_speech:
                self.in_speech = True
                self.silence_samples = 0
                self.speech_start_sample = self.total_samples - window.size
                pre = self.pre_roll.dump()
                if pre.size:
                    self.utterance.append(pre)
                self.utterance.append(window)
                if not self.speech_started_emitted:
                    self.speech_started_emitted = True
                    events.append(
                        SegmentEvent(kind="speech_started", timestamp_ms=timestamp_ms)
                    )
            return events

        # in speech
        self.utterance.append(window)
        if is_speech:
            self.silence_samples = 0
        else:
            self.silence_samples += int(window.size)

        if self.utterance.sample_count >= self.max_utterance_samples:
            events.extend(self._finalize(reason="max_utterance"))
            return events

        if self.silence_samples >= self.min_silence_samples:
            events.extend(self._finalize(reason="silence"))
        return events

    def _finalize(self, reason: str) -> list[SegmentEvent]:
        events: list[SegmentEvent] = []
        samples = self.utterance.to_array()
        # Trim trailing silence except speech pad
        if self.silence_samples > self.speech_pad_samples and samples.size > self.silence_samples:
            keep_silence = self.speech_pad_samples
            trim = self.silence_samples - keep_silence
            if trim > 0:
                samples = samples[: samples.size - trim]

        duration_ms = int(round(1000.0 * samples.size / self.sample_rate)) if samples.size else 0

        if samples.size < self.min_speech_samples:
            events.append(
                SegmentEvent(
                    kind="discarded",
                    duration_ms=duration_ms,
                    reason="too_short",
                )
            )
        else:
            events.append(
                SegmentEvent(
                    kind="utterance_ready",
                    samples=samples,
                    duration_ms=duration_ms,
                    reason=reason,
                )
            )

        self.in_speech = False
        self.speech_started_emitted = False
        self.silence_samples = 0
        self.utterance.clear()
        self.pre_roll.clear()
        self.vad.reset()
        return events
