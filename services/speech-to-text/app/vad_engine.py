"""Silero VAD ONNX wrapper with injectable fake for tests."""

from __future__ import annotations

from abc import ABC, abstractmethod
from pathlib import Path
from typing import Any

import numpy as np


class VadEngine(ABC):
    @abstractmethod
    def reset(self) -> None:
        raise NotImplementedError

    @abstractmethod
    def probability(self, window: np.ndarray) -> float:
        """Return speech probability for one 256-sample float32 window at 8 kHz."""
        raise NotImplementedError


class ThresholdVad(VadEngine):
    """Deterministic VAD used in unit tests (energy / injected scores)."""

    def __init__(self, scores: list[float] | None = None, energy_threshold: float = 0.02) -> None:
        self._scores = list(scores or [])
        self._index = 0
        self.energy_threshold = energy_threshold

    def reset(self) -> None:
        self._index = 0

    def probability(self, window: np.ndarray) -> float:
        if self._scores:
            if self._index >= len(self._scores):
                return 0.0
            score = float(self._scores[self._index])
            self._index += 1
            return score
        energy = float(np.sqrt(np.mean(np.square(window.astype(np.float32)))))
        return 1.0 if energy >= self.energy_threshold else 0.0


class SileroOnnxVad(VadEngine):
    """
    Silero VAD via ONNX Runtime.

    Loads a local ONNX file when provided. Otherwise attempts the silero_vad
    package ONNX helper once (models should be cached under /models).
    """

    def __init__(self, onnx_path: str | None = None, sample_rate: int = 8000) -> None:
        self.sample_rate = sample_rate
        self._session = None
        self._state = None
        self._context = None
        self._onnx_path = onnx_path
        self._load()

    def _load(self) -> None:
        import onnxruntime as ort

        path = self._resolve_onnx_path()
        opts = ort.SessionOptions()
        opts.inter_op_num_threads = 1
        opts.intra_op_num_threads = 1
        self._session = ort.InferenceSession(
            path,
            providers=["CPUExecutionProvider"],
            sess_options=opts,
        )
        self.reset()

    def _resolve_onnx_path(self) -> str:
        if self._onnx_path:
            path = Path(self._onnx_path)
            if not path.is_file():
                raise FileNotFoundError(f"Silero ONNX model not found: {path}")
            return str(path)

        # Prefer package-bundled ONNX without torch.hub at runtime.
        try:
            from silero_vad.utils_vad import init_onnx_model  # type: ignore

            # silero_vad may expose a path helper; fall through if unavailable
        except Exception:
            init_onnx_model = None

        candidates = [
            Path("/models/silero_vad.onnx"),
            Path(__file__).resolve().parent.parent / "models" / "silero_vad.onnx",
        ]
        for candidate in candidates:
            if candidate.is_file():
                return str(candidate)

        # Last resort: silero_vad load with onnx=True (uses cached package assets).
        try:
            from silero_vad import load_silero_vad

            model = load_silero_vad(onnx=True)
            # Some versions return an object wrapping the path / session.
            onnx_file = getattr(model, "model_path", None) or getattr(model, "path", None)
            if onnx_file and Path(str(onnx_file)).is_file():
                return str(onnx_file)
            # Keep the loaded wrapper if it exposes __call__
            self._callable = model
            self._session = None
            return ""
        except Exception as exc:  # pragma: no cover - exercised in integration
            raise RuntimeError(
                "Silero ONNX model unavailable. Run scripts/download_models.py"
            ) from exc

    def reset(self) -> None:
        self._state = None
        self._context = None
        if hasattr(self, "_callable") and self._callable is not None:
            reset = getattr(self._callable, "reset_states", None)
            if callable(reset):
                reset()

    def probability(self, window: np.ndarray) -> float:
        audio = np.asarray(window, dtype=np.float32).reshape(-1)
        if audio.size != 256:
            raise ValueError("Silero 8 kHz window must be exactly 256 samples")

        if getattr(self, "_callable", None) is not None and self._session is None:
            # silero_vad ONNX wrapper: model(audio, sample_rate)
            out = self._callable(audio, self.sample_rate)
            return float(out.item() if hasattr(out, "item") else out)

        assert self._session is not None
        inputs = self._session.get_inputs()
        feed: dict[str, Any] = {}
        # Common silero onnx signature: input, state, sr
        for inp in inputs:
            name = inp.name.lower()
            if "state" in name:
                if self._state is None:
                    # Infer shape from model input
                    shape = []
                    for dim in inp.shape:
                        shape.append(1 if isinstance(dim, str) or dim is None else int(dim))
                    self._state = np.zeros(shape, dtype=np.float32)
                feed[inp.name] = self._state
            elif name in {"sr", "sampling_rate"}:
                feed[inp.name] = np.array(self.sample_rate, dtype=np.int64)
            else:
                feed[inp.name] = audio.reshape(1, -1)

        outs = self._session.run(None, feed)
        # Update state if returned
        if len(outs) > 1:
            self._state = outs[1]
        return float(np.asarray(outs[0]).reshape(-1)[0])


def create_vad(onnx_path: str | None = None, *, fake: VadEngine | None = None) -> VadEngine:
    if fake is not None:
        return fake
    return SileroOnnxVad(onnx_path=onnx_path)
