/**
 * Generate temporary WAV samples for Phase 4F English human voice review.
 * Does not place calls. Does not commit files.
 *
 * Usage:
 *   npm run phase4f:voice-samples
 *
 * After listening, set:
 *   PHASE4F_ENGLISH_VOICE_REVIEWED=true
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getConfig } from '../src/config.js';
import { synthesizeOutboundAudio } from '../src/streaming/tts/tts-provider-factory.js';
import {
  PHASE4F_VOICE_SAMPLES,
} from '../src/streaming/phase4f/guards.js';
import {
  PIPER_DEFAULT_ENGLISH_VOICE,
  PIPER_DEFAULT_ENGLISH_SPEAKER_ID,
} from '../src/streaming/tts/piper-voices.js';

function mulawByteToPcm16(mu) {
  const u = (~mu) & 0xff;
  const sign = u & 0x80;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;
  let sample = ((mantissa << 3) + 0x84) << exponent;
  sample -= 0x84;
  if (sign) sample = -sample;
  return sample;
}

function mulawToWavPcm16(mulawBytes, sampleRate = 8000) {
  const pcm = Buffer.alloc(mulawBytes.length * 2);
  for (let i = 0; i < mulawBytes.length; i += 1) {
    pcm.writeInt16LE(mulawByteToPcm16(mulawBytes[i]), i * 2);
  }
  const dataSize = pcm.length;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, pcm]);
}

async function main() {
  const config = getConfig();
  const voice =
    config.piper?.englishVoice ||
    process.env.PIPER_ENGLISH_VOICE ||
    PIPER_DEFAULT_ENGLISH_VOICE;
  const speakerId =
    config.piper?.englishSpeakerId ??
    Number(
      process.env.PIPER_ENGLISH_SPEAKER_ID ?? PIPER_DEFAULT_ENGLISH_SPEAKER_ID,
    );

  const outDir = join(tmpdir(), `phase4f-voice-review-${Date.now()}`);
  mkdirSync(outDir, { recursive: true });

  const results = [];
  for (const sample of PHASE4F_VOICE_SAMPLES) {
    const synthesized = await synthesizeOutboundAudio(
      sample.text,
      {
        language: 'en',
        voice,
        speakerId,
        requireMatchingScript: false,
      },
      config,
    );
    const bytes = Buffer.from(synthesized.bytes || []);
    const wav = mulawToWavPcm16(bytes);
    const path = join(outDir, `${sample.id}.wav`);
    writeFileSync(path, wav);
    results.push({
      id: sample.id,
      path,
      byteLength: bytes.length,
      provider: synthesized.provider || null,
      voice: synthesized.voice || voice,
      speakerId,
    });
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        outDir,
        voice,
        speakerId,
        samples: results,
        checklist: [
          'Speech is understandable',
          'Volume is acceptable',
          'No severe clipping',
          'Pronunciation is acceptable',
          'Voice does not sound broken',
          'Greeting clearly states that this is an automated test',
        ],
        next: 'After listening, set PHASE4F_ENGLISH_VOICE_REVIEWED=true in .env.phase4f',
        networkRequestMade: false,
      },
      null,
      2,
    ),
  );
  console.log('PHASE4F_VOICE_SAMPLES_OK');
}

main().catch((err) => {
  console.error(
    JSON.stringify({
      ok: false,
      error: err?.message || 'voice_samples_failed',
      networkRequestMade: false,
    }),
  );
  process.exit(1);
});
