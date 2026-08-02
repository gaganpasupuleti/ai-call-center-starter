#!/usr/bin/env node
/**
 * Local Kokoro smoke test. Does not place telephone calls.
 *
 * Usage:
 *   npm run test:kokoro-local
 *   npm run test:kokoro-local -- --out ./artifacts/kokoro-smoke.ulaw
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { KokoroTextToSpeech } from '../src/streaming/tts/kokoro-client.js';
import { KOKORO_DEFAULT_VOICE } from '../src/streaming/tts/kokoro-voices.js';

const args = process.argv.slice(2);
let outPath = null;
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--out' && args[i + 1]) {
    outPath = args[i + 1];
    i += 1;
  }
}

const baseUrl = (process.env.KOKORO_BASE_URL || 'http://127.0.0.1:8880').replace(
  /\/+$/,
  '',
);
const voice = process.env.KOKORO_DEFAULT_VOICE || KOKORO_DEFAULT_VOICE;
const text =
  process.env.KOKORO_SMOKE_TEXT ||
  'Certainly. We will send the course details to your WhatsApp number.';

const tts = new KokoroTextToSpeech({
  baseUrl,
  defaultVoice: voice,
  cacheEnabled: false,
  retryOnce: false,
});

const started = Date.now();
try {
  const health = await tts.getHealth();
  if (!health.reachable) {
    console.error(
      JSON.stringify({
        ok: false,
        error: 'Kokoro voices endpoint not reachable',
        configured: health.configured,
      }),
    );
    process.exit(2);
  }

  // Measure PCM size via a one-off fetch by synthesizing once
  const result = await tts.synthesize({
    text,
    language: 'en',
    voice,
    speed: Number(process.env.KOKORO_DEFAULT_SPEED || 1),
  });
  const elapsed = Date.now() - started;

  const report = {
    ok: true,
    voice: result.voice,
    provider: result.provider,
    mulawByteLength: result.audio.length,
    estimatedDurationSeconds: result.durationSeconds,
    requestDurationMs: elapsed,
    synthesisDurationMs: result.synthesisDurationMs,
  };
  console.log(JSON.stringify(report, null, 2));

  if (outPath) {
    mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
    writeFileSync(outPath, result.audio);
    console.error(`Wrote μ-law audio to ${outPath}`);
  }
} catch (error) {
  console.error(
    JSON.stringify({
      ok: false,
      code: error?.code || 'tts_error',
      message: error?.message || 'smoke test failed',
    }),
  );
  process.exit(1);
}
