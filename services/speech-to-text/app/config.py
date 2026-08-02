from __future__ import annotations

import os
from dataclasses import dataclass


def _env_float(name: str, default: float) -> float:
    raw = os.getenv(name)
    if raw is None or raw == "":
        return default
    try:
        return float(raw)
    except ValueError:
        return default


def _env_int(name: str, default: int) -> int:
    raw = os.getenv(name)
    if raw is None or raw == "":
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def _env_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None or raw == "":
        return default
    return str(raw).strip().lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class Settings:
    host: str = "0.0.0.0"
    port: int = 8000
    service_token: str = ""

    sample_rate: int = 8000
    vad_window_samples: int = 256

    vad_threshold: float = 0.50
    vad_min_speech_ms: int = 250
    vad_min_silence_ms: int = 800
    vad_speech_pad_ms: int = 120
    vad_max_utterance_ms: int = 12000
    vad_pre_roll_ms: int = 200

    whisper_model: str = "small"
    whisper_device: str = "cpu"
    whisper_compute_type: str = "int8"
    whisper_cpu_threads: int = 4
    whisper_num_workers: int = 1
    whisper_beam_size: int = 1
    whisper_condition_on_previous_text: bool = False
    whisper_download_root: str = "/models"
    whisper_local_files_only: bool = False
    max_concurrent_transcriptions: int = 2

    silero_onnx_path: str = ""
    load_model_on_startup: bool = True

    @classmethod
    def from_env(cls) -> "Settings":
        return cls(
            host=os.getenv("HOST", "0.0.0.0"),
            port=_env_int("PORT", 8000),
            service_token=os.getenv("STT_SERVICE_TOKEN", "") or "",
            vad_threshold=_env_float("VAD_THRESHOLD", 0.50),
            vad_min_speech_ms=_env_int("VAD_MIN_SPEECH_MS", 250),
            vad_min_silence_ms=_env_int("VAD_MIN_SILENCE_MS", 800),
            vad_speech_pad_ms=_env_int("VAD_SPEECH_PAD_MS", 120),
            vad_max_utterance_ms=_env_int("VAD_MAX_UTTERANCE_MS", 12000),
            vad_pre_roll_ms=_env_int("VAD_PRE_ROLL_MS", 200),
            whisper_model=os.getenv("WHISPER_MODEL", "small"),
            whisper_device=os.getenv("WHISPER_DEVICE", "cpu"),
            whisper_compute_type=os.getenv("WHISPER_COMPUTE_TYPE", "int8"),
            whisper_cpu_threads=_env_int("WHISPER_CPU_THREADS", 4),
            whisper_num_workers=_env_int("WHISPER_NUM_WORKERS", 1),
            whisper_beam_size=_env_int("WHISPER_BEAM_SIZE", 1),
            whisper_condition_on_previous_text=_env_bool(
                "WHISPER_CONDITION_ON_PREVIOUS_TEXT", False
            ),
            whisper_download_root=os.getenv("WHISPER_DOWNLOAD_ROOT", "/models"),
            whisper_local_files_only=_env_bool("WHISPER_LOCAL_FILES_ONLY", False),
            max_concurrent_transcriptions=_env_int(
                "STT_MAX_CONCURRENT_TRANSCRIPTIONS", 2
            ),
            silero_onnx_path=os.getenv("SILERO_ONNX_PATH", "") or "",
            load_model_on_startup=_env_bool("STT_LOAD_MODEL_ON_STARTUP", True),
        )


settings = Settings.from_env()
