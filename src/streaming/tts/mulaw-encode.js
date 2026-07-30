import { AUDIO, MULAW_SILENCE } from '../constants.js';

export function linear16ToMulawSample(sample) {
  const MULAW_MAX = 0x1fff;
  const BIAS = 0x84;
  let sign = (sample >> 8) & 0x80;
  if (sign) sample = -sample;
  if (sample > MULAW_MAX) sample = MULAW_MAX;
  sample += BIAS;
  let exponent = 7;
  for (
    let expMask = 0x4000;
    (sample & expMask) === 0 && exponent > 0;
    exponent -= 1, expMask >>= 1
  ) {
    // find exponent
  }
  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

export function pcm16leMonoToMulaw(pcm) {
  if (!Buffer.isBuffer(pcm) || pcm.length < 2) {
    throw Object.assign(new Error('PCM buffer is empty'), {
      code: 'tts_pcm_empty',
      statusCode: 500,
    });
  }
  const sampleCount = Math.floor(pcm.length / 2);
  const mulaw = Buffer.alloc(sampleCount);
  let energetic = 0;
  for (let i = 0; i < sampleCount; i += 1) {
    const sample = pcm.readInt16LE(i * 2);
    if (Math.abs(sample) > 200) energetic += 1;
    mulaw[i] = linear16ToMulawSample(sample);
  }
  const energyRatio = energetic / sampleCount;
  if (energyRatio < 0.02) {
    throw Object.assign(new Error('Synthesized audio appears silence-only'), {
      code: 'tts_audio_silence',
      statusCode: 500,
    });
  }
  return {
    bytes: mulaw,
    byteLength: mulaw.length,
    durationSeconds: Number((mulaw.length / AUDIO.sampleRate).toFixed(3)),
    sampleRate: AUDIO.sampleRate,
    channels: 1,
    encoding: AUDIO.encoding,
    energyRatio: Number(energyRatio.toFixed(4)),
  };
}

export function silenceMulawMs(ms = 300) {
  const samples = Math.max(1, Math.round((AUDIO.sampleRate * ms) / 1000));
  return Buffer.alloc(samples, MULAW_SILENCE);
}

export function concatMulawWithRepeats(mulawBytes, repeatCount, gapMs = 350) {
  const times = Math.max(1, Math.min(5, Number(repeatCount) || 1));
  const gap = silenceMulawMs(gapMs);
  const parts = [];
  for (let i = 0; i < times; i += 1) {
    parts.push(mulawBytes);
    if (i < times - 1) parts.push(gap);
  }
  return Buffer.concat(parts);
}
