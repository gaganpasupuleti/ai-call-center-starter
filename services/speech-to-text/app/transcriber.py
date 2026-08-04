"""In-memory WAV helpers and Faster-Whisper transcription."""

from __future__ import annotations

import asyncio
import io
import time
import wave
from dataclasses import dataclass
from typing import Protocol

import numpy as np


@dataclass
class TranscriptResult:
    text: str
    language: str | None
    language_probability: float | None
    audio_duration_ms: int
    inference_duration_ms: int


class Transcriber(Protocol):
    async def transcribe(
        self,
        pcm_float32: np.ndarray,
        *,
        language: str,
        sample_rate: int = 8000,
    ) -> TranscriptResult:
        ...


def float32_to_pcm16_bytes(samples: np.ndarray) -> bytes:
    clipped = np.clip(samples.astype(np.float32), -1.0, 1.0)
    pcm = (clipped * 32767.0).astype(np.int16)
    return pcm.tobytes()


def build_wav_bytes(pcm16: bytes, *, sample_rate: int = 8000, channels: int = 1) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(channels)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(pcm16)
    return buf.getvalue()


def pcm_float32_to_wav_bytes(samples: np.ndarray, *, sample_rate: int = 8000) -> bytes:
    return build_wav_bytes(float32_to_pcm16_bytes(samples), sample_rate=sample_rate)


class FakeTranscriber:
    """Deterministic transcriber for unit tests."""

    def __init__(self, text: str = "hello", language: str = "en", probability: float = 0.9) -> None:
        self.text = text
        self.language = language
        self.probability = probability
        self.calls: list[dict] = []

    async def transcribe(
        self,
        pcm_float32: np.ndarray,
        *,
        language: str,
        sample_rate: int = 8000,
    ) -> TranscriptResult:
        self.calls.append(
            {
                "language": language,
                "samples": int(np.asarray(pcm_float32).size),
                "sample_rate": sample_rate,
            }
        )
        detected = self.language if language == "auto" else language
        duration_ms = int(round(1000.0 * np.asarray(pcm_float32).size / sample_rate))
        return TranscriptResult(
            text=self.text,
            language=detected,
            language_probability=self.probability,
            audio_duration_ms=duration_ms,
            inference_duration_ms=1,
        )


class FasterWhisperTranscriber:
    def __init__(self, model_registry, settings, semaphore: asyncio.Semaphore | None = None) -> None:
        self.registry = model_registry
        self.settings = settings
        self.semaphore = semaphore or asyncio.Semaphore(
            max(1, int(settings.max_concurrent_transcriptions))
        )

    async def transcribe(
        self,
        pcm_float32: np.ndarray,
        *,
        language: str,
        sample_rate: int = 8000,
    ) -> TranscriptResult:
        async with self.semaphore:
            return await asyncio.to_thread(
                self._transcribe_sync,
                pcm_float32,
                language,
                sample_rate,
            )

    def _transcribe_sync(
        self,
        pcm_float32: np.ndarray,
        language: str,
        sample_rate: int,
    ) -> TranscriptResult:
        model = self.registry.require_model()
        samples = np.asarray(pcm_float32, dtype=np.float32).reshape(-1)
        # Whisper is trained at 16 kHz; upsample 8 kHz telephony audio before decode.
        whisper_rate = 16_000
        if sample_rate != whisper_rate and samples.size > 0 and sample_rate > 0:
            target_n = max(1, int(round(samples.size * whisper_rate / float(sample_rate))))
            src_x = np.linspace(0.0, 1.0, num=samples.size, endpoint=False)
            dst_x = np.linspace(0.0, 1.0, num=target_n, endpoint=False)
            samples = np.interp(dst_x, src_x, samples).astype(np.float32)
            sample_rate = whisper_rate
        wav_bytes = pcm_float32_to_wav_bytes(samples, sample_rate=sample_rate)
        bio = io.BytesIO(wav_bytes)
        bio.name = "utterance.wav"
        started = time.perf_counter()
        whisper_language = None if language == "auto" else language
        segments, info = model.transcribe(
            bio,
            language=whisper_language,
            task="transcribe",
            beam_size=int(self.settings.whisper_beam_size),
            condition_on_previous_text=bool(
                self.settings.whisper_condition_on_previous_text
            ),
            word_timestamps=False,
            vad_filter=False,
        )
        text = " ".join(seg.text.strip() for seg in segments if seg.text).strip()
        elapsed_ms = int((time.perf_counter() - started) * 1000)
        detected = getattr(info, "language", whisper_language or "en")
        prob = getattr(info, "language_probability", None)
        duration_ms = int(round(1000.0 * samples.size / sample_rate)) if sample_rate else 0
        # Never translate; keep detected language code as returned.
        return TranscriptResult(
            text=text,
            language=detected,
            language_probability=float(prob) if prob is not None else None,
            audio_duration_ms=duration_ms,
            inference_duration_ms=elapsed_ms,
        )
