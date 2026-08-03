#!/usr/bin/env node
/**
 * Generate temporary synthetic caller μ-law fixtures.
 *
 * English → Kokoro (private)
 * Telugu → Piper (private)
 *
 * Prefer running inside Railway private network (ssh / one-off job).
 * Do not commit generated audio. Deletes temp WAV by default.
 *
 * Usage:
 *   node scripts/generate-synthetic-caller-fixture.mjs --language en --text "..." --out /tmp/caller.ulaw
 *   node scripts/generate-synthetic-caller-fixture.mjs --language te --text "..." --out /tmp/caller.ulaw
 *   node scripts/generate-synthetic-caller-fixture.mjs --input-wav ./consented.wav --out /tmp/caller.ulaw
 */
import { mkdtempSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { KokoroTextToSpeech } from '../src/streaming/tts/kokoro-client.js';
import { PiperTextToSpeech } from '../src/streaming/tts/piper-client.js';
import { KOKORO_DEFAULT_VOICE } from '../src/streaming/tts/kokoro-voices.js';
import { PIPER_DEFAULT_VOICE } from '../src/streaming/tts/piper-voices.js';
import { wavFileToMulaw8k, isValidMulaw8k } from './lib/wav-mulaw.mjs';

function parseArgs(argv) {
  const out = {
    language: 'en',
    text: null,
    inputWav: null,
    out: null,
    keepWav: false,
    voice: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--language' && argv[i + 1]) out.language = argv[++i];
    else if (a === '--text' && argv[i + 1]) out.text = argv[++i];
    else if (a === '--input-wav' && argv[i + 1]) out.inputWav = argv[++i];
    else if (a === '--out' && argv[i + 1]) out.out = argv[++i];
    else if (a === '--voice' && argv[i + 1]) out.voice = argv[++i];
    else if (a === '--keep-wav') out.keepWav = true;
  }
  return out;
}

async function synthesizeEnglish(text, voice) {
  const baseUrl = (process.env.KOKORO_BASE_URL || '').replace(/\/+$/, '');
  if (!baseUrl) {
    throw new Error('KOKORO_BASE_URL required for English synthetic fixtures');
  }
  const selected = voice || process.env.KOKORO_DEFAULT_VOICE || KOKORO_DEFAULT_VOICE;
  const tts = new KokoroTextToSpeech({
    baseUrl,
    defaultVoice: selected,
    cacheEnabled: false,
    retryOnce: false,
  });
  const result = await tts.synthesize({ text, language: 'en', voice: selected });
  return {
    mulaw: result.audio,
    provider: result.provider,
    voice: result.voice,
  };
}

async function synthesizeTelugu(text, voice) {
  const baseUrl = (process.env.PIPER_BASE_URL || '').replace(/\/+$/, '');
  if (!baseUrl) {
    throw new Error('PIPER_BASE_URL required for Telugu synthetic fixtures');
  }
  const selected =
    voice || process.env.PIPER_DEFAULT_VOICE || PIPER_DEFAULT_VOICE;
  const tts = new PiperTextToSpeech({
    baseUrl,
    defaultVoice: selected,
    cacheEnabled: false,
    retryOnce: false,
  });
  const result = await tts.synthesize({ text, language: 'te', voice: selected });
  return {
    mulaw: result.audio,
    provider: result.provider,
    voice: result.voice,
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

    const synth =
      language === 'te'
        ? await synthesizeTelugu(args.text, args.voice)
        : await synthesizeEnglish(args.text, args.voice);

    if (!isValidMulaw8k(synth.mulaw)) {
      throw new Error('Synthesized fixture is not valid μ-law');
    }
    writeFileSync(args.out, synth.mulaw);

    console.log(
      JSON.stringify(
        {
          ok: true,
          mode: 'synthetic-tts',
          language,
          textLength: args.text.length,
          sourceProvider: synth.provider,
          sourceVoice: synth.voice,
          out: args.out,
          bytes: synth.mulaw.length,
          durationSeconds: Number((synth.mulaw.length / 8000).toFixed(3)),
          encoding: 'audio/x-mulaw',
          sampleRate: 8000,
          telephoneCalls: 0,
        },
        null,
        2,
      ),
    );
  } finally {
    if (!args.keepWav && existsSync(tempWav)) {
      try {
        unlinkSync(tempWav);
        deleted.push(tempWav);
      } catch {
        // ignore cleanup errors
      }
    }
    if (deleted.length) {
      console.error(JSON.stringify({ deletedTempFiles: deleted }));
    }
  }
}

main().catch((err) => {
  console.error(JSON.stringify({ ok: false, error: err.message }));
  process.exit(1);
});
