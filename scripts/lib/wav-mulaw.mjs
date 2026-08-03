/**
 * Shared WAV → G.711 μ-law 8 kHz mono helpers for fixtures and audio-mode sims.
 */
import { readFileSync, writeFileSync } from 'node:fs';

export function linearToMulaw(sample) {
  const MULAW_MAX = 0x1fff;
  const BIAS = 0x84;
  let sign = (sample >> 8) & 0x80;
  if (sign) sample = -sample;
  if (sample > MULAW_MAX) sample = MULAW_MAX;
  sample = sample + BIAS;
  let exponent = 7;
  for (
    let expMask = 0x4000;
    (sample & expMask) === 0 && exponent > 0;
    exponent--, expMask >>= 1
  ) {
    // find exponent
  }
  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

export function parseWav(buffer) {
  if (
    buffer.toString('ascii', 0, 4) !== 'RIFF' ||
    buffer.toString('ascii', 8, 12) !== 'WAVE'
  ) {
    throw new Error('Not a RIFF/WAVE file');
  }
  let offset = 12;
  let fmt = null;
  let data = null;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (id === 'fmt ') {
      fmt = {
        audioFormat: buffer.readUInt16LE(start),
        channels: buffer.readUInt16LE(start + 2),
        sampleRate: buffer.readUInt32LE(start + 4),
        bitsPerSample: buffer.readUInt16LE(start + 14),
      };
    } else if (id === 'data') {
      data = buffer.subarray(start, start + size);
    }
    offset = start + size + (size % 2);
  }
  if (!fmt || !data) throw new Error('WAV missing fmt/data');
  if (fmt.audioFormat !== 1) throw new Error('Only PCM WAV supported');
  if (fmt.bitsPerSample !== 16) throw new Error('Only 16-bit PCM supported');
  return { fmt, data };
}

export function resampleMono16(pcm, fromRate, toRate) {
  if (fromRate === toRate) return pcm;
  const inSamples = pcm.length / 2;
  const outSamples = Math.max(1, Math.round((inSamples * toRate) / fromRate));
  const out = Buffer.alloc(outSamples * 2);
  for (let i = 0; i < outSamples; i += 1) {
    const srcPos = (i * fromRate) / toRate;
    const left = Math.floor(srcPos);
    const right = Math.min(inSamples - 1, left + 1);
    const frac = srcPos - left;
    const a = pcm.readInt16LE(left * 2);
    const b = pcm.readInt16LE(right * 2);
    const mixed = Math.round(a + (b - a) * frac);
    out.writeInt16LE(Math.max(-32768, Math.min(32767, mixed)), i * 2);
  }
  return out;
}

export function toMono(pcm, channels) {
  if (channels === 1) return pcm;
  const frames = pcm.length / (2 * channels);
  const out = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i += 1) {
    let sum = 0;
    for (let c = 0; c < channels; c += 1) {
      sum += pcm.readInt16LE((i * channels + c) * 2);
    }
    out.writeInt16LE(Math.round(sum / channels), i * 2);
  }
  return out;
}

export function wavBufferToMulaw8k(wavBuffer, { allowNearSilence = false } = {}) {
  const wav = parseWav(
    Buffer.isBuffer(wavBuffer) ? wavBuffer : Buffer.from(wavBuffer),
  );
  let pcm = toMono(wav.data, wav.fmt.channels);
  pcm = resampleMono16(pcm, wav.fmt.sampleRate, 8000);
  const mulaw = Buffer.alloc(pcm.length / 2);
  let nonSilence = 0;
  for (let i = 0; i < mulaw.length; i += 1) {
    const sample = pcm.readInt16LE(i * 2);
    if (Math.abs(sample) > 200) nonSilence += 1;
    mulaw[i] = linearToMulaw(sample);
  }
  if (mulaw.length === 0) throw new Error('Empty mulaw output');
  const ratio = nonSilence / mulaw.length;
  if (!allowNearSilence && ratio < 0.02) {
    throw new Error('Audio appears silence-only');
  }
  return {
    mulaw,
    sampleRate: 8000,
    channels: 1,
    encoding: 'audio/x-mulaw',
    durationSeconds: Number((mulaw.length / 8000).toFixed(3)),
    nonSilenceRatio: Number(ratio.toFixed(4)),
  };
}

export function wavFileToMulaw8k(inputPath, outputPath, options) {
  const converted = wavBufferToMulaw8k(readFileSync(inputPath), options);
  if (outputPath) writeFileSync(outputPath, converted.mulaw);
  return converted;
}

export function writePcm16Wav(pcm16leMono, sampleRate, outputPath) {
  const dataSize = pcm16leMono.length;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);
  pcm16leMono.copy(buffer, 44);
  if (outputPath) writeFileSync(outputPath, buffer);
  return buffer;
}

export function isValidMulaw8k(bytes, { minBytes = 160 } = {}) {
  if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) return false;
  if (bytes.length < minBytes) return false;
  if (bytes.length % 160 !== 0 && bytes.length < 800) {
    // Allow short trailing frame; still require non-trivial size.
  }
  return true;
}
