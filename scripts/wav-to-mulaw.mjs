/**
 * Convert a PCM WAV file to raw G.711 μ-law 8 kHz mono.
 * Usage: node scripts/wav-to-mulaw.mjs <input.wav> <output.ulaw>
 */
import { readFileSync, writeFileSync } from 'node:fs';

function linearToMulaw(sample) {
  const MULAW_MAX = 0x1fff;
  const BIAS = 0x84;
  let sign = (sample >> 8) & 0x80;
  if (sign) sample = -sample;
  if (sample > MULAW_MAX) sample = MULAW_MAX;
  sample = sample + BIAS;
  let exponent = 7;
  for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; exponent--, expMask >>= 1) {
    // find exponent
  }
  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  const mulaw = ~(sign | (exponent << 4) | mantissa) & 0xff;
  return mulaw;
}

function parseWav(buffer) {
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
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

function resampleMono16(pcm, fromRate, toRate) {
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

function toMono(pcm, channels) {
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

const [, , inputPath, outputPath] = process.argv;
if (!inputPath || !outputPath) {
  console.error('Usage: node scripts/wav-to-mulaw.mjs <input.wav> <output.ulaw>');
  process.exit(1);
}

const wav = parseWav(readFileSync(inputPath));
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
if (nonSilence / mulaw.length < 0.02) throw new Error('Audio appears silence-only');

writeFileSync(outputPath, mulaw);
const durationSec = mulaw.length / 8000;
console.log(
  JSON.stringify({
    output: outputPath,
    bytes: mulaw.length,
    sampleRate: 8000,
    channels: 1,
    encoding: 'audio/x-mulaw',
    durationSeconds: Number(durationSec.toFixed(3)),
    nonSilenceRatio: Number((nonSilence / mulaw.length).toFixed(4)),
  }),
);
