#!/usr/bin/env node
/**
 * Sequential Kokoro stability battery (Phase 4E.2).
 * Defaults to concurrency=1 for acceptance. Optional concurrency=2 probe.
 *
 *   node scripts/test-kokoro-stability.mjs --requests 20 --concurrency 1
 *   node scripts/test-kokoro-stability.mjs --requests 10 --concurrency 2
 */
import { KokoroTextToSpeech } from '../src/streaming/tts/kokoro-client.js';
import { KOKORO_DEFAULT_VOICE } from '../src/streaming/tts/kokoro-voices.js';

function parseArgs(argv) {
  const out = {
    requests: 20,
    concurrency: 1,
    text: 'Hello, this is a short Kokoro stability check.',
    timeoutMs: Number(process.env.TTS_REQUEST_TIMEOUT_MS || 30_000),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--requests' && argv[i + 1]) out.requests = Number(argv[++i]);
    else if (a === '--concurrency' && argv[i + 1]) out.concurrency = Number(argv[++i]);
    else if (a === '--text' && argv[i + 1]) out.text = argv[++i];
  }
  return out;
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

async function warmUp(tts, voice) {
  const voices = await tts.getHealth();
  if (!voices.reachable) {
    throw new Error('kokoro_voices_unreachable');
  }
  const warm = await tts.synthesize({
    text: 'Warm up.',
    language: 'en',
    voice,
  });
  // Discard warm-up audio after validating length
  if (!warm.audio?.length) throw new Error('kokoro_warmup_empty');
  return { discardedBytes: warm.audio.length };
}

async function runOne(tts, voice, text) {
  const started = Date.now();
  try {
    const result = await tts.synthesize({ text, language: 'en', voice });
    const ms = Date.now() - started;
    if (!result.audio?.length) {
      return { ok: false, timeout: false, ms, error: 'empty' };
    }
    return { ok: true, timeout: false, ms, bytes: result.audio.length };
  } catch (err) {
    const ms = Date.now() - started;
    const timeout = /timeout/i.test(err.message || '');
    return { ok: false, timeout, ms, error: err.code || err.message };
  }
}

async function runPool(n, concurrency, worker) {
  const results = [];
  let next = 0;
  async function lane() {
    while (next < n) {
      const i = next;
      next += 1;
      // eslint-disable-next-line no-await-in-loop
      results[i] = await worker(i);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, () => lane()));
  return results;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const baseUrl = (process.env.KOKORO_BASE_URL || 'http://127.0.0.1:8880').replace(
    /\/+$/,
    '',
  );
  const voice = process.env.KOKORO_DEFAULT_VOICE || KOKORO_DEFAULT_VOICE;
  const tts = new KokoroTextToSpeech({
    baseUrl,
    defaultVoice: voice,
    cacheEnabled: false,
    retryOnce: false,
    connectTimeoutMs: Number(process.env.TTS_CONNECT_TIMEOUT_MS || 10_000),
    requestTimeoutMs: args.timeoutMs,
  });

  const warm = await warmUp(tts, voice);
  const results = await runPool(args.requests, args.concurrency, () =>
    runOne(tts, voice, args.text),
  );

  const successes = results.filter((r) => r.ok);
  const failures = results.filter((r) => !r.ok);
  const timeouts = results.filter((r) => r.timeout);
  const latencies = successes.map((r) => r.ms).sort((a, b) => a - b);

  const report = {
    ok: failures.length === 0,
    provider: 'kokoro-local',
    voice,
    concurrency: args.concurrency,
    requests: args.requests,
    successes: successes.length,
    failures: failures.length,
    timeouts: timeouts.length,
    warmUpDiscardedBytes: warm.discardedBytes,
    minimum: latencies[0] ?? null,
    median: percentile(latencies, 50),
    p95: percentile(latencies, 95),
    maximum: latencies[latencies.length - 1] ?? null,
    telephoneCalls: 0,
  };
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exit(1);
}

main().catch((err) => {
  console.error(JSON.stringify({ ok: false, error: err.message, telephoneCalls: 0 }));
  process.exit(1);
});
