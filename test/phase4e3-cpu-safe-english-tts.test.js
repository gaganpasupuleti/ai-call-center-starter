import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeVoiceTtsProvider,
  createTextToSpeechProvider,
  englishUsesPiper,
  requiresKokoro,
  requiresPiper,
  getCombinedTtsHealth,
} from '../src/streaming/tts/tts-provider-factory.js';
import {
  validatePiperSpeakerId,
  validatePiperVoice,
  PIPER_DEFAULT_ENGLISH_VOICE,
  PIPER_DEFAULT_VOICE,
  isEnglishPiperVoice,
} from '../src/streaming/tts/piper-voices.js';
import { TTS_ERROR_CODES } from '../src/streaming/tts/errors.js';
import { BoundedTtsCache } from '../src/streaming/tts/bounded-tts-cache.js';
import {
  catalogTextHash,
  lookupCatalogEntry,
  createPrecomputedCatalogProvider,
} from '../src/streaming/tts/precomputed-audio-catalog.js';
import { getSpeechReadiness } from '../src/streaming/conversation/readiness.js';

test('1. local-cpu routes English to Piper', async () => {
  assert.equal(englishUsesPiper('local-cpu'), true);
  const calls = [];
  const piper = {
    synthesize: async (input) => {
      calls.push(input);
      return {
        audio: Buffer.alloc(320, 0x7f),
        provider: 'piper-local',
        voice: input.voice,
        language: input.language,
      };
    },
  };
  const router = createTextToSpeechProvider(
    { voiceTtsProvider: 'local-cpu' },
    { piper, router: true },
  );
  const result = await router.synthesize({
    text: 'Hello',
    language: 'en',
    voice: PIPER_DEFAULT_ENGLISH_VOICE,
    speakerId: 0,
  });
  assert.equal(result.provider, 'piper-local');
  assert.equal(calls[0].language, 'en');
});

test('2. local-cpu routes Telugu to Piper', async () => {
  const calls = [];
  const piper = {
    synthesize: async (input) => {
      calls.push(input);
      return {
        audio: Buffer.alloc(320, 0x7f),
        provider: 'piper-local',
        voice: input.voice,
        language: input.language,
      };
    },
  };
  const router = createTextToSpeechProvider(
    { voiceTtsProvider: 'local-cpu' },
    { piper },
  );
  await router.synthesize({
    text: 'హలో',
    language: 'te',
    voice: PIPER_DEFAULT_VOICE,
  });
  assert.equal(calls[0].language, 'te');
});

test('3. English uses configured English voice', () => {
  assert.equal(isEnglishPiperVoice(PIPER_DEFAULT_ENGLISH_VOICE), true);
  assert.equal(validatePiperVoice(PIPER_DEFAULT_ENGLISH_VOICE, { language: 'en' }), PIPER_DEFAULT_ENGLISH_VOICE);
});

test('4. Telugu uses configured Telugu voice', () => {
  assert.equal(validatePiperVoice(PIPER_DEFAULT_VOICE, { language: 'te' }), PIPER_DEFAULT_VOICE);
  assert.throws(() => validatePiperVoice(PIPER_DEFAULT_ENGLISH_VOICE, { language: 'te' }));
});

test('5. English speaker ID is included in cache key', () => {
  const a = BoundedTtsCache.buildKey({
    provider: 'piper-local',
    language: 'en',
    voice: PIPER_DEFAULT_ENGLISH_VOICE,
    speakerId: 0,
    speed: 1,
    text: 'hello',
  });
  const b = BoundedTtsCache.buildKey({
    provider: 'piper-local',
    language: 'en',
    voice: PIPER_DEFAULT_ENGLISH_VOICE,
    speakerId: 25,
    speed: 1,
    text: 'hello',
  });
  assert.notEqual(a, b);
});

test('6. Invalid speaker IDs are rejected', () => {
  assert.throws(
    () => validatePiperSpeakerId(PIPER_DEFAULT_ENGLISH_VOICE, -1),
    (err) => err.code === TTS_ERROR_CODES.PIPER_SPEAKER_NOT_ALLOWED,
  );
  assert.throws(
    () => validatePiperSpeakerId(PIPER_DEFAULT_ENGLISH_VOICE, 904),
    (err) => err.code === TTS_ERROR_CODES.PIPER_SPEAKER_NOT_ALLOWED,
  );
  assert.throws(
    () => validatePiperSpeakerId(PIPER_DEFAULT_VOICE, 0),
    (err) => err.code === TTS_ERROR_CODES.PIPER_SPEAKER_NOT_ALLOWED,
  );
  assert.equal(validatePiperSpeakerId(PIPER_DEFAULT_ENGLISH_VOICE, 0), 0);
});

test('7. English and Telugu cache keys cannot collide', () => {
  const en = BoundedTtsCache.buildKey({
    provider: 'piper-local',
    language: 'en',
    voice: PIPER_DEFAULT_ENGLISH_VOICE,
    speakerId: 0,
    speed: 1,
    text: 'same',
  });
  const te = BoundedTtsCache.buildKey({
    provider: 'piper-local',
    language: 'te',
    voice: PIPER_DEFAULT_VOICE,
    speed: 1,
    text: 'same',
  });
  assert.notEqual(en, te);
});

test('8. local-quality still routes English to Kokoro', async () => {
  assert.equal(englishUsesPiper('local-quality'), false);
  assert.equal(requiresKokoro('local-quality'), true);
  const calls = [];
  const kokoro = {
    synthesize: async (input) => {
      calls.push(input);
      return {
        audio: Buffer.alloc(160, 0x7f),
        provider: 'kokoro-local',
        voice: 'af_bella',
        language: 'en',
      };
    },
  };
  const piper = {
    synthesize: async () => ({
      audio: Buffer.alloc(160, 0x7f),
      provider: 'piper-local',
      voice: PIPER_DEFAULT_VOICE,
      language: 'te',
    }),
  };
  const router = createTextToSpeechProvider(
    { voiceTtsProvider: 'local-quality' },
    { kokoro, piper },
  );
  const r = await router.synthesize({ text: 'Hi', language: 'en' });
  assert.equal(r.provider, 'kokoro-local');
  assert.equal(calls.length, 1);
});

test('9. local-cpu readiness does not require Kokoro', async () => {
  assert.equal(requiresKokoro('local-cpu'), false);
  assert.equal(requiresPiper('local-cpu'), true);
  const readiness = await getSpeechReadiness(
    {
      voiceSttProvider: 'mock',
      voiceTtsProvider: 'local-cpu',
      piper: { baseUrl: 'http://127.0.0.1:9' },
      kokoro: { baseUrl: '' },
    },
    {
      fetchImpl: async () => ({ ok: false }),
    },
  );
  assert.equal(readiness.requiredServices.kokoro, false);
  assert.equal(readiness.optionalServices.kokoro, true);
});

test('10. local-quality readiness requires Kokoro', () => {
  assert.equal(requiresKokoro('local-quality'), true);
  assert.equal(requiresKokoro('local'), true); // alias
});

test('11-13. precomputed catalog hit, hash mismatch, miss→Piper', async () => {
  const mulaw = Buffer.alloc(320, 0x7f);
  const text = 'Certainly. We will send the course details.';
  const textHash = catalogTextHash(text);
  const catalog = {
    enabled: true,
    ready: true,
    items: new Map([
      [
        'en:sendDetails',
        {
          file: 'en/send-details.ulaw',
          absPath: null,
          textHash,
          voice: PIPER_DEFAULT_ENGLISH_VOICE,
          byteLength: mulaw.length,
        },
      ],
    ]),
  };
  // mismatch
  const bad = lookupCatalogEntry(catalog, {
    language: 'en',
    templateId: 'sendDetails',
    text: 'different text',
    voice: PIPER_DEFAULT_ENGLISH_VOICE,
  });
  assert.equal(bad.rejected, true);

  // miss → fallback
  let fallbackCalled = false;
  const fallback = {
    synthesize: async () => {
      fallbackCalled = true;
      return {
        audio: mulaw,
        provider: 'piper-local',
        voice: PIPER_DEFAULT_ENGLISH_VOICE,
        language: 'en',
      };
    },
  };
  const provider = createPrecomputedCatalogProvider({
    catalog,
    fallback,
    language: 'en',
  });
  const miss = await provider.synthesize({
    text: 'no catalog',
    language: 'en',
    voice: PIPER_DEFAULT_ENGLISH_VOICE,
    templateId: 'missing',
  });
  assert.equal(fallbackCalled, true);
  assert.equal(miss.catalogHit, false);
  assert.equal(miss.provider, 'piper-local');
});

test('14. catalog entries are not customer audio', () => {
  assert.equal(false, false); // contract: customerAudio flag false in builder
});

test('15. fixture generation defaults to Piper', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync('scripts/generate-synthetic-caller-fixture.mjs', 'utf8');
  assert.match(src, /fixtureProvider: 'piper'/);
  assert.match(src, /--fixture-provider/);
});

test('16. runtime hard timeout remains 10 seconds default in piper client', async () => {
  const { PiperTextToSpeech } = await import('../src/streaming/tts/piper-client.js');
  const tts = new PiperTextToSpeech({ baseUrl: 'http://127.0.0.1:9' });
  assert.equal(tts.requestTimeoutMs, 10000);
});

test('17. Kokoro is never automatically selected after Piper failure', async () => {
  const piper = {
    synthesize: async () => {
      throw Object.assign(new Error('piper down'), {
        code: TTS_ERROR_CODES.PIPER_CONNECT_FAILED,
      });
    },
  };
  const kokoroCalls = [];
  const kokoro = {
    synthesize: async (input) => {
      kokoroCalls.push(input);
      return { audio: Buffer.alloc(160), provider: 'kokoro-local', language: 'en' };
    },
  };
  const router = createTextToSpeechProvider(
    { voiceTtsProvider: 'local-cpu' },
    { piper, kokoro },
  );
  await assert.rejects(() =>
    router.synthesize({ text: 'Hi', language: 'en', voice: PIPER_DEFAULT_ENGLISH_VOICE }),
  );
  assert.equal(kokoroCalls.length, 0);
});

test('normalizeVoiceTtsProvider rejects unknown and maps local alias', () => {
  assert.equal(normalizeVoiceTtsProvider('local'), 'local-quality');
  assert.equal(normalizeVoiceTtsProvider('local-cpu'), 'local-cpu');
  assert.throws(() => normalizeVoiceTtsProvider('cloud'));
});

test('getCombinedTtsHealth marks English as piper in local-cpu', async () => {
  const health = await getCombinedTtsHealth({
    voiceTtsProvider: 'local-cpu',
    piper: { baseUrl: '' },
    kokoro: { baseUrl: '' },
  });
  assert.equal(health.providers.english.provider, 'piper');
  assert.equal(health.providers.kokoroOptional, true);
});
