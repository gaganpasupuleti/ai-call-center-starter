/**
 * Offline synthetic μ-law tone (8 kHz mono) for fixture validation tests.
 * Not speech — used only when TTS is unavailable in CI.
 */
import { AUDIO, MULAW_SILENCE } from '../../src/streaming/constants.js';

function linearToMulaw(sample) {
  const MULAW_MAX = 0x1fff;
  const MULAW_BIAS = 33;
  let sign = (sample >> 8) & 0x80;
  if (sign) sample = -sample;
  if (sample > MULAW_MAX) sample = MULAW_MAX;
  sample += MULAW_BIAS;
  let exponent = 7;
  for (
    let expMask = 0x4000;
    (sample & expMask) === 0 && exponent > 0;
    exponent -= 1, expMask >>= 1
  ) {
    // find exponent
  }
  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  const mulaw = ~(sign | (exponent << 4) | mantissa) & 0xff;
  return mulaw;
}

/**
 * Generate a 440 Hz tone with mild amplitude suitable for validation.
 */
export function generateToneMulaw({
  durationMs = 1200,
  frequencyHz = 440,
  amplitude = 0.35,
  sampleRate = AUDIO.sampleRate,
} = {}) {
  const samples = Math.max(1, Math.round((durationMs / 1000) * sampleRate));
  const out = Buffer.alloc(samples);
  for (let i = 0; i < samples; i += 1) {
    const t = i / sampleRate;
    const linear = Math.sin(2 * Math.PI * frequencyHz * t) * amplitude;
    const pcm16 = Math.max(-32767, Math.min(32767, Math.round(linear * 32767)));
    out[i] = linearToMulaw(pcm16);
  }
  // Ensure not all silence
  if (out.every((b) => b === MULAW_SILENCE)) {
    out[0] = 0x00;
  }
  return out;
}
