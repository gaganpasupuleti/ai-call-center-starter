"""G.711 μ-law decoder (no audioop dependency)."""

from __future__ import annotations

import numpy as np

# ITU-T G.711 μ-law expand table → signed 16-bit PCM
_BIAS = 0x84
_CLIP = 32635


def _decode_byte(mu: int) -> int:
    mu = (~int(mu)) & 0xFF
    sign = mu & 0x80
    exponent = (mu >> 4) & 0x07
    mantissa = mu & 0x0F
    sample = ((mantissa << 3) + _BIAS) << exponent
    sample -= _BIAS
    if sign:
        sample = -sample
    if sample > _CLIP:
        sample = _CLIP
    if sample < -_CLIP:
        sample = -_CLIP
    return sample


MULAW_DECODE_TABLE = np.array([_decode_byte(i) for i in range(256)], dtype=np.int16)


def mulaw_bytes_to_pcm16(mulaw: bytes | bytearray | memoryview | np.ndarray) -> np.ndarray:
    """Decode 8-bit μ-law bytes to signed PCM16."""
    arr = np.frombuffer(bytes(mulaw), dtype=np.uint8)
    return MULAW_DECODE_TABLE[arr].astype(np.int16, copy=False)


def pcm16_to_float32(pcm16: np.ndarray) -> np.ndarray:
    """Normalize PCM16 to float32 in [-1.0, 1.0]."""
    return (pcm16.astype(np.float32) / 32768.0).clip(-1.0, 1.0)


def mulaw_bytes_to_float32(mulaw: bytes | bytearray | memoryview | np.ndarray) -> np.ndarray:
    return pcm16_to_float32(mulaw_bytes_to_pcm16(mulaw))
