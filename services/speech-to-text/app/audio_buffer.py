"""In-memory audio buffering helpers for 8 kHz streaming VAD."""

from __future__ import annotations

from collections import deque

import numpy as np


class SampleRemainder:
    """Accumulate samples until exact VAD windows can be emitted."""

    def __init__(self, window_samples: int = 256) -> None:
        if window_samples <= 0:
            raise ValueError("window_samples must be positive")
        self.window_samples = window_samples
        self._buf = np.zeros(0, dtype=np.float32)

    def push(self, samples: np.ndarray) -> list[np.ndarray]:
        if samples is None or len(samples) == 0:
            return []
        chunk = np.asarray(samples, dtype=np.float32).reshape(-1)
        self._buf = np.concatenate([self._buf, chunk]) if self._buf.size else chunk
        windows: list[np.ndarray] = []
        while self._buf.size >= self.window_samples:
            windows.append(self._buf[: self.window_samples].copy())
            self._buf = self._buf[self.window_samples :]
        return windows

    @property
    def remainder_size(self) -> int:
        return int(self._buf.size)

    def clear(self) -> None:
        self._buf = np.zeros(0, dtype=np.float32)


class RingBuffer:
    """Fixed-capacity sample ring used for pre-roll."""

    def __init__(self, max_samples: int) -> None:
        self.max_samples = max(0, int(max_samples))
        self._samples = deque(maxlen=self.max_samples or None)

    def push(self, samples: np.ndarray) -> None:
        if self.max_samples <= 0 or samples is None or len(samples) == 0:
            return
        for value in np.asarray(samples, dtype=np.float32).reshape(-1):
            self._samples.append(float(value))

    def dump(self) -> np.ndarray:
        if not self._samples:
            return np.zeros(0, dtype=np.float32)
        out = np.asarray(self._samples, dtype=np.float32)
        self._samples.clear()
        return out

    def clear(self) -> None:
        self._samples.clear()

    def __len__(self) -> int:
        return len(self._samples)


class UtteranceBuffer:
    """Growable float32 PCM buffer for one caller utterance."""

    def __init__(self) -> None:
        self._chunks: list[np.ndarray] = []
        self._samples = 0

    def append(self, samples: np.ndarray) -> None:
        if samples is None or len(samples) == 0:
            return
        arr = np.asarray(samples, dtype=np.float32).reshape(-1)
        self._chunks.append(arr.copy())
        self._samples += int(arr.size)

    @property
    def sample_count(self) -> int:
        return self._samples

    def duration_ms(self, sample_rate: int = 8000) -> int:
        if sample_rate <= 0:
            return 0
        return int(round(1000.0 * self._samples / sample_rate))

    def to_array(self) -> np.ndarray:
        if not self._chunks:
            return np.zeros(0, dtype=np.float32)
        return np.concatenate(self._chunks)

    def clear(self) -> None:
        self._chunks.clear()
        self._samples = 0
