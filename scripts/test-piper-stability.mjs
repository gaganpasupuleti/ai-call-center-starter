#!/usr/bin/env node
/**
 * Piper stability battery (English or Telugu).
 *
 *   node scripts/test-piper-stability.mjs --language en --requests 20 --concurrency 1
 *   node scripts/test-piper-stability.mjs --language te --requests 20 --concurrency 1
 */
import { PiperTextToSpeech } from '../src/streaming/tts/piper-client.js';
import {
  PIPER_DEFAULT_VOICE,
  PIPER_DEFAULT_ENGLISH_VOICE,
  PIPER_DEFAULT_ENGLISH_SPEAKER_ID,
} from '../src/streaming/tts/piper-voices.js';
import { AUDIO } from '../src/streaming/constants.js';

const SENTENCES = {
  en: [
    'Certainly. We will send the course details to your WhatsApp number.',
    'We can schedule a free demo session for you.',
    'Thank you for your time. We will call you back tomorrow.',
    'Understood. We will not call you again.',
    'Hello, this is Code Quest.',
  ],
  te: [
    'వివరాలు మీ వాట్సాప్‌కు పంపుతాము.',
    'డెమో సెషన్ షెడ్యూల్ చేస్తాము.',
    'ధన్యవాదాలు. రేపు కాల్ చేస్తాము.',
    'సరే. మళ్లీ కాల్ చేయము.',
    'హలో, ఇది కోడ్ క్వెస్ట్.',
  ],
};

function parseArgs(argv) {
  const out = {
    language: 'en',
    requests: 20,
    concurrency: 1,
    timeoutMs: Number(process.env.TTS_REQUEST_TIMEOUT_MS || 10_000),
    speakerId: Number(
      process.env.PIPER_ENGLISH_SPEAKER_ID ?? PIPER_DEFAULT_ENGLISH_SPEAKER_ID,
    ),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--language' && argv[i + 1]) out.language = argv[++i];
    else if (a === '--requests' && argv[i + 1]) out.requests = Number(argv[++i]);
    else if (a === '--concurrency' && argv[i + 1]) out.concurrency = Number(argv[++i]);
    else if (a === '--timeout-ms' && argv[i + 1]) out.timeoutMs = Number(argv[++i]);
    else if (a === '--speaker-id' && argv[i + 1]) out.speakerId = Number(argv[++i]);
  }
  return out;
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

async function runOne(tts, language, text, speakerId) {
  const started = Date.now();
  try {
    const result = await tts.synthesize({
      text,
      language,
      voice:
        language === 'en' ? PIPER_DEFAULT_ENGLISH_VOICE : PIPER_DEFAULT_VOICE,
      speakerId: language === 'en' ? speakerId : undefined,
    });
    const ms = Date.now() - started;
    const durationMs = Math.round(
      (result.audio?.length || 0) / AUDIO.sampleRate * 1000,
    );
    if (!result.audio?.length) {
      return { ok: false, timeout: false, ms, error: 'empty' };
    }
    return {
      ok: true,
      timeout: false,
      ms,
      bytes: result.audio.length,
      durationMs,
      rtf: durationMs > 0 ? ms / durationMs : null,
    };
  } catch (err) {
    const ms = Date.now() - started;
    const timeout = /timeout/i.test(err.message || '') || err.code?.includes('timeout');
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
  const language = args.language === 'te' ? 'te' : 'en';
  const baseUrl = (process.env.PIPER_BASE_URL || 'http://127.0.0.1:5000').replace(
    /\/+$/,
    '',
  );
  const sentences = SENTENCES[language];
  const tts = new PiperTextToSpeech({
    baseUrl,
    defaultVoice: PIPER_DEFAULT_VOICE,
    defaultEnglishVoice: PIPER_DEFAULT_ENGLISH_VOICE,
    defaultEnglishSpeakerId: args.speakerId,
    cacheEnabled: false,
    retryOnce: false,
    requestTimeoutMs: args.timeoutMs,
  });

  const health = await tts.getHealth();
  if (!health.reachable) {
    console.log(
      JSON.stringify({
        ok: false,
        error: 'piper_unreachable',
        telephoneCalls: 0,
      }),
    );
    process.exit(2);
  }

  const results = await runPool(args.requests, args.concurrency, (i) =>
    runOne(tts, language, sentences[i % sentences.length], args.speakerId),
  );

  const successes = results.filter((r) => r.ok);
  const failures = results.filter((r) => !r.ok);
  const timeouts = results.filter((r) => r.timeout);
  const latencies = successes.map((r) => r.ms).sort((a, b) => a - b);
  const durations = successes.map((r) => r.durationMs);
  const avgDuration =
    durations.length > 0
      ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
      : null;
  const rtfs = successes.map((r) => r.rtf).filter((x) => x != null);
  const avgRtf =
    rtfs.length > 0
      ? Number((rtfs.reduce((a, b) => a + b, 0) / rtfs.length).toFixed(3))
      : null;

  const report = {
    ok: failures.length === 0,
    provider: 'piper-local',
    language,
    voice: language === 'en' ? PIPER_DEFAULT_ENGLISH_VOICE : PIPER_DEFAULT_VOICE,
    speakerId: language === 'en' ? args.speakerId : null,
    concurrency: args.concurrency,
    requests: args.requests,
    hardTimeoutMs: args.timeoutMs,
    successes: successes.length,
    failures: failures.length,
    timeouts: timeouts.length,
    minimum: latencies[0] ?? null,
    median: percentile(latencies, 50),
    p95: percentile(latencies, 95),
    maximum: latencies[latencies.length - 1] ?? null,
    averageAudioDurationMs: avgDuration,
    averageRealTimeFactor: avgRtf,
    telephoneCalls: 0,
  };
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exit(1);
}

main().catch((err) => {
  console.error(JSON.stringify({ ok: false, error: err.message, telephoneCalls: 0 }));
  process.exit(1);
});
