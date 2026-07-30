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

function mulawByteToLinear16(muLawByte) {
  const MULAW_BIAS = 0x84;
  let mu = ~muLawByte & 0xff;
  const sign = mu & 0x80;
  const exponent = (mu >> 4) & 0x07;
  const mantissa = mu & 0x0f;
  let sample = (((mantissa << 3) + MULAW_BIAS) << exponent) - MULAW_BIAS;
  return sign ? -sample : sample;
}

export function mulawToPcm16le(mulawBytes) {
  const source = Buffer.isBuffer(mulawBytes)
    ? mulawBytes
    : Buffer.from(mulawBytes ?? []);
  const pcm = Buffer.alloc(source.length * 2);
  for (let i = 0; i < source.length; i += 1) {
    pcm.writeInt16LE(mulawByteToLinear16(source[i]), i * 2);
  }
  return pcm;
}

/** Browser-playable WAV (PCM 16-bit LE mono). */
export function pcm16leToWav(pcm, sampleRate = AUDIO.sampleRate, channels = 1) {
  const dataSize = pcm.length;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, pcm]);
}

export function mulawToWavBase64(mulawBytes, sampleRate = AUDIO.sampleRate) {
  const pcm = mulawToPcm16le(mulawBytes);
  const wav = pcm16leToWav(pcm, sampleRate, 1);
  return {
    mimeType: 'audio/wav',
    base64: wav.toString('base64'),
    byteLength: wav.length,
    sampleRate,
    channels: 1,
  };
}
