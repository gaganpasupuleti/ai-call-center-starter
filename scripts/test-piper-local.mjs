#!/usr/bin/env node
/**
 * Local Piper smoke test. Does not place telephone calls.
 *
 * Usage:
 *   npm run test:piper-local
 *   npm run test:piper-local -- --out ./artifacts/piper-smoke.ulaw
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { wavToMulaw8k } from '../src/streaming/tts/audio-normalizer.js';
import { PIPER_DEFAULT_VOICE } from '../src/streaming/tts/piper-voices.js';

const args = process.argv.slice(2);
let outPath = null;
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--out' && args[i + 1]) {
    outPath = args[i + 1];
    i += 1;
  }
}

const baseUrl = (process.env.PIPER_BASE_URL || 'http://127.0.0.1:5000').replace(
  /\/+$/,
  '',
);
const voice = process.env.PIPER_DEFAULT_VOICE || PIPER_DEFAULT_VOICE;
const text =
  process.env.PIPER_SMOKE_TEXT ||
  'నమస్కారం. కోడ్ క్వెస్ట్‌కు స్వాగతం.';

const started = Date.now();
try {
  const infoRes = await fetch(`${baseUrl}/info`);
  if (!infoRes.ok) throw new Error(`/info returned ${infoRes.status}`);
  await infoRes.json().catch(() => ({}));

  const voicesRes = await fetch(`${baseUrl}/voices`);
  if (!voicesRes.ok) throw new Error(`/voices returned ${voicesRes.status}`);
  await voicesRes.json().catch(() => ([]));

  const synthRes = await fetch(`${baseUrl}/synthesize`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, voice, length_scale: 1.0 }),
  });
  if (!synthRes.ok) throw new Error(`/synthesize returned ${synthRes.status}`);
  const wav = Buffer.from(await synthRes.arrayBuffer());
  const converted = await wavToMulaw8k(wav);
  const elapsed = Date.now() - started;

  console.log(
    [
      `provider=piper-local`,
      `voice=${voice}`,
      `wavByteLength=${wav.length}`,
      `mulawByteLength=${converted.audio.length}`,
      `estimatedDuration=${converted.durationSeconds}`,
      `requestDurationMs=${elapsed}`,
    ].join('\n'),
  );

  if (outPath) {
    mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
    writeFileSync(outPath, converted.audio);
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
