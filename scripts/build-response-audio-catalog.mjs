#!/usr/bin/env node
/**
 * Build deterministic response μ-law catalog (offline).
 * Does not place telephone calls. Do not commit generated audio by default.
 *
 *   node scripts/build-response-audio-catalog.mjs --provider piper --language en
 *   node scripts/build-response-audio-catalog.mjs --provider kokoro --language en --request-timeout-ms 120000
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { KokoroTextToSpeech } from '../src/streaming/tts/kokoro-client.js';
import { PiperTextToSpeech } from '../src/streaming/tts/piper-client.js';
import { KOKORO_DEFAULT_VOICE } from '../src/streaming/tts/kokoro-voices.js';
import {
  PIPER_DEFAULT_ENGLISH_VOICE,
  PIPER_DEFAULT_ENGLISH_SPEAKER_ID,
  PIPER_DEFAULT_VOICE,
} from '../src/streaming/tts/piper-voices.js';
import {
  buildCatalogKey,
  catalogTextHash,
} from '../src/streaming/tts/precomputed-audio-catalog.js';
import { AUDIO } from '../src/streaming/constants.js';

const TEMPLATES = {
  en: {
    sendDetails: 'Certainly. We will send the course details to your WhatsApp number.',
    bookDemo: 'Great. We can schedule a free demo session for you.',
    callback: 'Understood. We will call you back at a better time.',
    notInterested: 'Thank you for your time. Have a good day.',
    doNotCall: 'Understood. We will not call you again.',
    humanAgent: 'Please hold while we connect you with an agent.',
  },
  te: {
    sendDetails: 'వివరాలు మీ వాట్సాప్‌కు పంపుతాము.',
    callback: 'సరే. మేము మళ్లీ కాల్ చేస్తాము.',
    notInterested: 'ధన్యవాదాలు. శుభదినం.',
    doNotCall: 'సరే. మళ్లీ కాల్ చేయము.',
  },
};

function parseArgs(argv) {
  const out = {
    provider: 'piper',
    language: 'en',
    outDir: path.join(process.cwd(), 'generated', 'response-audio'),
    requestTimeoutMs: Number(process.env.TTS_REQUEST_TIMEOUT_MS || 30_000),
    speakerId: Number(
      process.env.PIPER_ENGLISH_SPEAKER_ID ?? PIPER_DEFAULT_ENGLISH_SPEAKER_ID,
    ),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--provider' && argv[i + 1]) out.provider = argv[++i];
    else if (a === '--language' && argv[i + 1]) out.language = argv[++i];
    else if (a === '--out-dir' && argv[i + 1]) out.outDir = argv[++i];
    else if (a === '--request-timeout-ms' && argv[i + 1]) {
      out.requestTimeoutMs = Number(argv[++i]);
    } else if (a === '--speaker-id' && argv[i + 1]) out.speakerId = Number(argv[++i]);
  }
  return out;
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const language = args.language === 'te' ? 'te' : 'en';
  const templates = TEMPLATES[language];
  mkdirSync(path.join(args.outDir, language), { recursive: true });

  let synthesize;
  let voice;
  let providerName;
  if (args.provider === 'kokoro') {
    if (language !== 'en') throw new Error('kokoro catalog is English-only');
    voice = KOKORO_DEFAULT_VOICE;
    providerName = 'kokoro-local';
    const tts = new KokoroTextToSpeech({
      baseUrl: (process.env.KOKORO_BASE_URL || '').replace(/\/+$/, ''),
      cacheEnabled: false,
      requestTimeoutMs: args.requestTimeoutMs,
    });
    synthesize = (text) => tts.synthesize({ text, language: 'en', voice });
  } else {
    voice =
      language === 'en' ? PIPER_DEFAULT_ENGLISH_VOICE : PIPER_DEFAULT_VOICE;
    providerName = 'piper-local';
    const tts = new PiperTextToSpeech({
      baseUrl: (process.env.PIPER_BASE_URL || '').replace(/\/+$/, ''),
      cacheEnabled: false,
      requestTimeoutMs: args.requestTimeoutMs,
      defaultEnglishSpeakerId: args.speakerId,
    });
    synthesize = (text) =>
      tts.synthesize({
        text,
        language,
        voice,
        speakerId: language === 'en' ? args.speakerId : undefined,
      });
  }

  const items = {};
  for (const [templateId, text] of Object.entries(templates)) {
    const result = await synthesize(text);
    const file = `${language}/${templateId.replace(/([A-Z])/g, '-$1').toLowerCase().replace(/^-/, '')}.ulaw`;
    const abs = path.join(args.outDir, file);
    writeFileSync(abs, result.audio);
    const textHash = catalogTextHash(text);
    const key = buildCatalogKey({
      language,
      templateId,
      textHash,
      voice,
      speed: 1,
    });
    const simple = `${language}:${templateId}`;
    const entry = {
      file,
      textHash,
      provider: providerName,
      voice,
      speakerId: language === 'en' && args.provider === 'piper' ? args.speakerId : null,
      byteLength: result.audio.length,
      durationMs: Math.round((result.audio.length / AUDIO.sampleRate) * 1000),
      sha256: sha256(result.audio),
      customerAudio: false,
    };
    items[key] = entry;
    items[simple] = entry;
  }

  const manifest = {
    version: 1,
    format: { encoding: 'mulaw', sampleRate: 8000, channels: 1 },
    generatedAt: new Date().toISOString(),
    provider: providerName,
    language,
    items,
    note: 'Bot response templates only — never customer audio',
  };
  writeFileSync(
    path.join(args.outDir, 'manifest.json'),
    JSON.stringify(manifest, null, 2),
  );
  console.log(
    JSON.stringify(
      {
        ok: true,
        outDir: args.outDir,
        count: Object.keys(templates).length,
        provider: providerName,
        telephoneCalls: 0,
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(JSON.stringify({ ok: false, error: err.message }));
  process.exit(1);
});
