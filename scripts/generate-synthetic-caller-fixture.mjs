#!/usr/bin/env node
/**
 * Generate temporary synthetic caller μ-law fixtures.
 *
 * Default (Phase 4E.3):
 *   English → Piper English
 *   Telugu  → Piper Telugu
 *
 * Optional quality path:
 *   --fixture-provider kokoro  (English only; offline / not for live gate A)
 *
 * Do not commit generated audio.
 */
import { mkdtempSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { KokoroTextToSpeech } from '../src/streaming/tts/kokoro-client.js';
import { PiperTextToSpeech } from '../src/streaming/tts/piper-client.js';
import { KOKORO_DEFAULT_VOICE } from '../src/streaming/tts/kokoro-voices.js';
import {
  PIPER_DEFAULT_VOICE,
  PIPER_DEFAULT_ENGLISH_VOICE,
  PIPER_DEFAULT_ENGLISH_SPEAKER_ID,
} from '../src/streaming/tts/piper-voices.js';
import { wavFileToMulaw8k, isValidMulaw8k } from './lib/wav-mulaw.mjs';

function parseArgs(argv) {
  const out = {
    language: 'en',
    text: null,
    inputWav: null,
    out: null,
    keepWav: false,
    voice: null,
    speakerId: null,
    fixtureProvider: 'piper',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--language' && argv[i + 1]) out.language = argv[++i];
    else if (a === '--text' && argv[i + 1]) out.text = argv[++i];
    else if (a === '--input-wav' && argv[i + 1]) out.inputWav = argv[++i];
    else if (a === '--out' && argv[i + 1]) out.out = argv[++i];
    else if (a === '--voice' && argv[i + 1]) out.voice = argv[++i];
    else if (a === '--speaker-id' && argv[i + 1]) out.speakerId = Number(argv[++i]);
    else if (a === '--fixture-provider' && argv[i + 1]) out.fixtureProvider = argv[++i];
    else if (a === '--keep-wav') out.keepWav = true;
  }
  return out;
}

async function synthesizeEnglishKokoro(text, voice) {
  const baseUrl = (process.env.KOKORO_BASE_URL || '').replace(/\/+$/, '');
  if (!baseUrl) {
    throw new Error('KOKORO_BASE_URL required for --fixture-provider kokoro');
  }
  const selected = voice || process.env.KOKORO_DEFAULT_VOICE || KOKORO_DEFAULT_VOICE;
  const tts = new KokoroTextToSpeech({
    baseUrl,
    defaultVoice: selected,
    cacheEnabled: false,
    retryOnce: true,
    connectTimeoutMs: Number(process.env.TTS_CONNECT_TIMEOUT_MS || 10_000),
    requestTimeoutMs: Number(
      process.env.FIXTURE_TTS_REQUEST_TIMEOUT_MS ||
        process.env.TTS_REQUEST_TIMEOUT_MS ||
        120_000,
    ),
  });
  const result = await tts.synthesize({ text, language: 'en', voice: selected });
  return {
    mulaw: result.audio,
    provider: result.provider,
    voice: result.voice,
  };
}

async function synthesizeWithPiper(text, { language, voice, speakerId }) {
  const baseUrl = (process.env.PIPER_BASE_URL || '').replace(/\/+$/, '');
  if (!baseUrl) {
    throw new Error('PIPER_BASE_URL required for Piper fixtures');
  }
  const selected =
    voice ||
    (language === 'en'
      ? process.env.PIPER_ENGLISH_VOICE || PIPER_DEFAULT_ENGLISH_VOICE
      : process.env.PIPER_TELUGU_VOICE ||
        process.env.PIPER_DEFAULT_VOICE ||
        PIPER_DEFAULT_VOICE);
  const sid =
    language === 'en'
      ? speakerId ??
        Number(process.env.PIPER_ENGLISH_SPEAKER_ID ?? PIPER_DEFAULT_ENGLISH_SPEAKER_ID)
      : undefined;
  const tts = new PiperTextToSpeech({
    baseUrl,
    defaultVoice: PIPER_DEFAULT_VOICE,
    defaultEnglishVoice: PIPER_DEFAULT_ENGLISH_VOICE,
    defaultEnglishSpeakerId: PIPER_DEFAULT_ENGLISH_SPEAKER_ID,
    cacheEnabled: false,
    retryOnce: true,
    connectTimeoutMs: Number(process.env.TTS_CONNECT_TIMEOUT_MS || 10_000),
    requestTimeoutMs: Number(
      process.env.FIXTURE_TTS_REQUEST_TIMEOUT_MS ||
        process.env.TTS_REQUEST_TIMEOUT_MS ||
        30_000,
    ),
  });
  const result = await tts.synthesize({
    text,
    language,
    voice: selected,
    speakerId: sid,
  });
  return {
    mulaw: result.audio,
    provider: result.provider,
    voice: result.voice,
    speakerId: result.speakerId ?? null,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const language = args.language === 'te' ? 'te' : 'en';
  if (!args.out) {
    console.error(JSON.stringify({ ok: false, error: '--out is required' }));
    process.exit(2);
  }

  const tempDir = mkdtempSync(path.join(tmpdir(), 'caller-fixture-'));
  const tempWav = path.join(tempDir, 'source.wav');
  const deleted = [];

  try {
    if (args.inputWav) {
      if (!existsSync(args.inputWav)) {
        throw new Error(`input wav not found: ${args.inputWav}`);
      }
      const converted = wavFileToMulaw8k(args.inputWav, args.out);
      console.log(
        JSON.stringify(
          {
            ok: true,
            mode: 'input-wav',
            language,
            out: args.out,
            bytes: converted.mulaw.length,
            durationSeconds: converted.durationSeconds,
            encoding: converted.encoding,
            sampleRate: converted.sampleRate,
            telephoneCalls: 0,
          },
          null,
          2,
        ),
      );
      return;
    }

    if (!args.text) {
      throw new Error('--text or --input-wav is required');
    }

    let synth;
    if (language === 'en' && args.fixtureProvider === 'kokoro') {
      synth = await synthesizeEnglishKokoro(args.text, args.voice);
    } else {
      synth = await synthesizeWithPiper(args.text, {
        language,
        voice: args.voice,
        speakerId: args.speakerId,
      });
    }

    if (!isValidMulaw8k(synth.mulaw)) {
      throw new Error('synthesized μ-law failed validation');
    }
    writeFileSync(args.out, synth.mulaw);
    console.log(
      JSON.stringify(
        {
          ok: true,
          mode: 'synthetic',
          language,
          fixtureProvider: args.fixtureProvider,
          provider: synth.provider,
          voice: synth.voice,
          speakerId: synth.speakerId ?? null,
          out: args.out,
          bytes: synth.mulaw.length,
          telephoneCalls: 0,
        },
        null,
        2,
      ),
    );
  } catch (err) {
    console.error(JSON.stringify({ ok: false, error: err.message, telephoneCalls: 0 }));
    process.exit(1);
  } finally {
    if (!args.keepWav) {
      try {
        unlinkSync(tempWav);
        deleted.push(tempWav);
      } catch {
        // ignore
      }
    }
  }
}

main();
