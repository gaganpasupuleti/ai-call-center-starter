/**
 * Validate G.711 μ-law 8 kHz mono caller fixtures (no raw audio logged).
 */
import { AUDIO, MULAW_SILENCE } from '../../src/streaming/constants.js';

function mulawToLinear(muLawByte) {
  const MULAW_BIAS = 33;
  let mu = ~muLawByte & 0xff;
  const sign = mu & 0x80;
  const exponent = (mu >> 4) & 0x07;
  const mantissa = mu & 0x0f;
  let sample = ((mantissa << 3) + MULAW_BIAS) << exponent;
  sample -= MULAW_BIAS;
  return sign ? -sample : sample;
}

export function validateMulawFixture(bytes, {
  minDurationMs = 500,
  maxDurationMs = 8000,
  minRms = 0.02,
  maxPeak = 0.99,
} = {}) {
  if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) {
    return { valid: false, reason: 'not_buffer' };
  }
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (!buf.length) {
    return { valid: false, reason: 'empty' };
  }
  const durationMs = Math.round((buf.length / AUDIO.sampleRate) * 1000);
  if (durationMs < minDurationMs || durationMs > maxDurationMs) {
    return {
      valid: false,
      reason: 'duration_out_of_range',
      durationMs,
      sampleRate: AUDIO.sampleRate,
      channels: 1,
    };
  }

  let peak = 0;
  let sumSq = 0;
  let silenceCount = 0;
  for (let i = 0; i < buf.length; i += 1) {
    const sample = mulawToLinear(buf[i]) / 32768;
    const abs = Math.abs(sample);
    if (abs > peak) peak = abs;
    sumSq += sample * sample;
    if (buf[i] === MULAW_SILENCE) silenceCount += 1;
  }
  const rms = Math.sqrt(sumSq / buf.length);
  const dbfs = rms > 0 ? 20 * Math.log10(rms) : -Infinity;
  const silenceRatio = silenceCount / buf.length;

  if (peak < 0.05 || rms < minRms || silenceRatio > 0.95) {
    return {
      valid: false,
      reason: 'near_silent',
      durationMs,
      peak: Number(peak.toFixed(4)),
      rms: Number(rms.toFixed(4)),
      dbfs: Number(dbfs.toFixed(1)),
      sampleRate: AUDIO.sampleRate,
      channels: 1,
    };
  }
  if (peak > maxPeak) {
    return {
      valid: false,
      reason: 'clipped',
      durationMs,
      peak: Number(peak.toFixed(4)),
      rms: Number(rms.toFixed(4)),
      dbfs: Number(dbfs.toFixed(1)),
      sampleRate: AUDIO.sampleRate,
      channels: 1,
    };
  }

  return {
    valid: true,
    durationMs,
    peak: Number(peak.toFixed(4)),
    rms: Number(rms.toFixed(4)),
    dbfs: Number(dbfs.toFixed(1)),
    sampleRate: AUDIO.sampleRate,
    channels: 1,
    encoding: 'audio/x-mulaw',
    byteLength: buf.length,
  };
}

export function isResponseMulawValid(bytes, { minBytes = 160 } = {}) {
  if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) return false;
  if (bytes.length < minBytes) return false;
  let nonSilence = 0;
  for (let i = 0; i < bytes.length; i += 1) {
    if (bytes[i] !== MULAW_SILENCE) nonSilence += 1;
  }
  return nonSilence / bytes.length > 0.02;
}
