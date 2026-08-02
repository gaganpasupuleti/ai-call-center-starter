"""Shared Faster-Whisper model registry."""

from __future__ import annotations

import threading
from dataclasses import dataclass
from typing import Any


@dataclass
class ModelStatus:
    ready: bool = False
    model: str = "small"
    device: str = "cpu"
    compute_type: str = "int8"
    error: str | None = None


class ModelRegistry:
    def __init__(self, settings, loader=None) -> None:
        self.settings = settings
        self._loader = loader or self._default_loader
        self._model = None
        self._lock = threading.Lock()
        self.status = ModelStatus(
            ready=False,
            model=settings.whisper_model,
            device=settings.whisper_device,
            compute_type=settings.whisper_compute_type,
        )

    def _default_loader(self):
        from faster_whisper import WhisperModel

        return WhisperModel(
            self.settings.whisper_model,
            device=self.settings.whisper_device,
            compute_type=self.settings.whisper_compute_type,
            cpu_threads=int(self.settings.whisper_cpu_threads),
            num_workers=int(self.settings.whisper_num_workers),
            download_root=self.settings.whisper_download_root,
            local_files_only=bool(self.settings.whisper_local_files_only),
        )

    def load(self) -> Any:
        with self._lock:
            if self._model is not None and self.status.ready:
                return self._model
            try:
                self._model = self._loader()
                self.status.ready = True
                self.status.error = None
                return self._model
            except Exception as exc:  # pragma: no cover - exercised via fake loader
                self._model = None
                self.status.ready = False
                self.status.error = "model_load_failed"
                raise RuntimeError("model_load_failed") from exc

    def require_model(self) -> Any:
        if self._model is None or not self.status.ready:
            return self.load()
        return self._model

    def mark_failed(self, code: str = "model_load_failed") -> None:
        with self._lock:
            self._model = None
            self.status.ready = False
            self.status.error = code
