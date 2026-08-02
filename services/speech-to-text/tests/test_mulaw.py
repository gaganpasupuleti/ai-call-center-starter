import numpy as np

from app.mulaw import MULAW_DECODE_TABLE, mulaw_bytes_to_float32, mulaw_bytes_to_pcm16


def test_mulaw_returns_pcm16():
    pcm = mulaw_bytes_to_pcm16(bytes([0xFF, 0x7F, 0x00]))
    assert pcm.dtype == np.int16
    assert pcm.shape == (3,)


def test_mulaw_handles_all_256_values():
    data = bytes(range(256))
    pcm = mulaw_bytes_to_pcm16(data)
    assert pcm.shape == (256,)
    assert np.array_equal(pcm, MULAW_DECODE_TABLE)
    floats = mulaw_bytes_to_float32(data)
    assert floats.dtype == np.float32
    assert floats.min() >= -1.0
    assert floats.max() <= 1.0
