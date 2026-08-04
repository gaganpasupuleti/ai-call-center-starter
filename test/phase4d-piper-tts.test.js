import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { PiperTextToSpeech } from '../src/streaming/tts/piper-client.js';
import { KokoroTextToSpeech } from '../src/streaming/tts/kokoro-client.js';
import {
  LanguageTtsRouter,
  normalizeLanguage,
} from '../src/streaming/tts/language-router.js';
import { BoundedTtsCache } from '../src/streaming/tts/bounded-tts-cache.js';
import { TtsConcurrencyLimiter } from '../src/streaming/tts/tts-concurrency.js';
import {
  wavToMulaw8k,
  synthWavTone,
  synthPcmTone,
} from '../src/streaming/tts/audio-normalizer.js';
import { speedToLengthScale } from '../src/streaming/tts/piper-voices.js';
import {
  createTextToSpeechProvider,
  synthesizeOutboundAudio,
  normalizeVoiceTtsProvider,
  resolveOutboundTtsProvider,
  rejectLegacyMsEdge,
} from '../src/streaming/tts/tts-provider-factory.js';
import { TTS_ERROR_CODES, TtsProviderError } from '../src/streaming/tts/errors.js';
import { VoicePipeline } from '../src/streaming/ai/pipeline.js';
import { AdmissionsResponseEngine } from '../src/streaming/response/response-engine.js';
import { MockTextToSpeech } from '../src/streaming/ai/mock-tts.js';
import { getConfig } from '../src/config.js';

async function withFakePiper(handler, run) {
  const server = http.createServer((req, res) => handler(req, res, server));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await run(baseUrl, server);
  } finally {
    server.close();
    await once(server, 'close');
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function defaultPiperHandler(opts = {}) {
  let hits = 0;
  return async (req, res) => {
    if (req.url === '/info') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ service: 'piper-fake', version: '1.5.0' }));
      return;
    }
    if (req.url === '/voices') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify([
          'te_IN-padmavathi-medium',
          'te_IN-venkatesh-medium',
        ]),
      );
      return;
    }
    if (req.url === '/synthesize' && req.method === 'POST') {
      hits += 1;
      const raw = await readBody(req);
      const body = JSON.parse(raw.toString('utf8'));
      if (opts.onSynthesize) opts.onSynthesize(body, hits);
      if (opts.status) {
        res.writeHead(opts.status);
        res.end(opts.body || 'err');
        return;
      }
      if (opts.empty) {
        res.writeHead(200, { 'content-type': 'audio/wav' });
        res.end(Buffer.alloc(0));
        return;
      }
      if (opts.invalid) {
        res.writeHead(200, { 'content-type': 'audio/wav' });
        res.end(Buffer.from('not-a-wav'));
        return;
      }
      if (opts.oversized) {
        res.writeHead(200, { 'content-type': 'audio/wav' });
        res.end(Buffer.alloc(9_000_000, 1));
        return;
      }
      if (opts.hangMs) {
        await new Promise((r) => setTimeout(r, opts.hangMs));
      }
      const wav = synthWavTone({
        durationSeconds: opts.durationSeconds ?? 1,
        sampleRate: 22050,
      });
      res.writeHead(200, { 'content-type': 'audio/wav' });
      res.end(wav);
      return;
    }
    res.writeHead(404);
    res.end('missing');
  };
}

test('language aliases normalize to en/te', () => {
  assert.equal(normalizeLanguage('en-IN'), 'en');
  assert.equal(normalizeLanguage('en_US'), 'en');
  assert.equal(normalizeLanguage('English'), 'en');
  assert.equal(normalizeLanguage('te-IN'), 'te');
  assert.equal(normalizeLanguage('te_IN'), 'te');
  assert.equal(normalizeLanguage('Telugu'), 'te');
  assert.equal(normalizeLanguage('fr'), null);
});

test('speed maps to length_scale', () => {
  assert.equal(speedToLengthScale(1.0), 1);
  assert.ok(Math.abs(speedToLengthScale(1.1) - 1 / 1.1) < 0.001);
  assert.ok(Math.abs(speedToLengthScale(0.9) - 1 / 0.9) < 0.001);
});

test('Telugu routes to Piper; English to Kokoro; no cross-send', async () => {
  let piperHits = 0;
  let kokoroHits = 0;
  await withFakePiper(defaultPiperHandler({
    onSynthesize: () => {
      piperHits += 1;
    },
  }), async (piperUrl) => {
    const kokoroServer = http.createServer(async (req, res) => {
      if (req.url === '/v1/audio/voices') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ voices: ['af_bella'] }));
        return;
      }
      kokoroHits += 1;
      const pcm = synthPcmTone({ durationSeconds: 0.2, sampleRate: 24000 });
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(pcm);
    });
    kokoroServer.listen(0, '127.0.0.1');
    await once(kokoroServer, 'listening');
    const kokoroUrl = `http://127.0.0.1:${kokoroServer.address().port}`;

    try {
      const router = createTextToSpeechProvider(
        {
          voiceTtsProvider: 'local',
          kokoro: { baseUrl: kokoroUrl, defaultVoice: 'af_bella' },
          piper: { baseUrl: piperUrl, defaultVoice: 'te_IN-padmavathi-medium' },
          tts: { cacheEnabled: false },
        },
        { retryOnce: false },
      );

      const te = await router.synthesize({
        language: 'te',
        text: 'రేపు సాయంత్రం కాల్ చేస్తాము.',
      });
      assert.equal(te.provider, 'piper-local');
      assert.equal(piperHits, 1);
      assert.equal(kokoroHits, 0);

      const en = await router.synthesize({
        language: 'en',
        text: 'We will call you tomorrow evening.',
      });
      assert.equal(en.provider, 'kokoro-local');
      assert.equal(kokoroHits, 1);
      assert.equal(piperHits, 1);
    } finally {
      kokoroServer.close();
      await once(kokoroServer, 'close');
    }
  });
});

test('Piper request body, WAV→μ-law, ~8000 bytes/sec', async () => {
  let seen = null;
  await withFakePiper(
    defaultPiperHandler({
      onSynthesize: (body) => {
        seen = body;
      },
    }),
    async (baseUrl) => {
      const tts = new PiperTextToSpeech({
        baseUrl,
        cacheEnabled: false,
        retryOnce: false,
      });
      const result = await tts.synthesize({
        text: 'తప్పకుండా. కోర్సు వివరాలను మీ వాట్సాప్ నంబర్‌కు పంపిస్తాము.',
        language: 'te',
        voice: 'te_IN-padmavathi-medium',
        speed: 1.1,
      });
      assert.equal(seen.text.includes('తప్పకుండా'), true);
      assert.equal(seen.voice, 'te_IN-padmavathi-medium');
      assert.ok(Math.abs(seen.length_scale - 1 / 1.1) < 0.01);
      assert.equal(result.format.encoding, 'mulaw');
      assert.equal(result.format.sampleRate, 8000);
      assert.ok(result.audio.length > 7000 && result.audio.length < 9000);
    },
  );
});

test('invalid/empty/oversized/non-200/timeout WAV handling', async () => {
  await withFakePiper(defaultPiperHandler({ invalid: true }), async (baseUrl) => {
    const tts = new PiperTextToSpeech({
      baseUrl,
      cacheEnabled: false,
      retryOnce: false,
    });
    await assert.rejects(
      () => tts.synthesize({ text: 'నమస్కారం', language: 'te' }),
      (err) => err.code === TTS_ERROR_CODES.PIPER_INVALID_RESPONSE,
    );
  });

  await withFakePiper(defaultPiperHandler({ empty: true }), async (baseUrl) => {
    const tts = new PiperTextToSpeech({
      baseUrl,
      cacheEnabled: false,
      retryOnce: false,
    });
    await assert.rejects(
      () => tts.synthesize({ text: 'నమస్కారం', language: 'te' }),
      (err) => err.code === TTS_ERROR_CODES.PIPER_EMPTY_RESPONSE,
    );
  });

  await withFakePiper(defaultPiperHandler({ oversized: true }), async (baseUrl) => {
    const tts = new PiperTextToSpeech({
      baseUrl,
      maxWavBytes: 1000,
      cacheEnabled: false,
      retryOnce: false,
    });
    await assert.rejects(
      () => tts.synthesize({ text: 'నమస్కారం', language: 'te' }),
      (err) => err.code === TTS_ERROR_CODES.PIPER_RESPONSE_TOO_LARGE,
    );
  });

  await withFakePiper(defaultPiperHandler({ status: 500 }), async (baseUrl) => {
    const tts = new PiperTextToSpeech({
      baseUrl,
      cacheEnabled: false,
      retryOnce: false,
    });
    await assert.rejects(
      () => tts.synthesize({ text: 'నమస్కారం', language: 'te' }),
      (err) => err.code === TTS_ERROR_CODES.PIPER_HTTP_ERROR,
    );
  });

  await withFakePiper(defaultPiperHandler({ hangMs: 200 }), async (baseUrl) => {
    const tts = new PiperTextToSpeech({
      baseUrl,
      requestTimeoutMs: 50,
      cacheEnabled: false,
      retryOnce: false,
    });
    await assert.rejects(
      () => tts.synthesize({ text: 'నమస్కారం', language: 'te' }),
      (err) => err.code === TTS_ERROR_CODES.PIPER_REQUEST_TIMEOUT,
    );
  });
});

test('voice allowlist and language/voice mismatches', async () => {
  await withFakePiper(defaultPiperHandler(), async (baseUrl) => {
    const tts = new PiperTextToSpeech({
      baseUrl,
      cacheEnabled: false,
      retryOnce: false,
    });
    await assert.rejects(
      () =>
        tts.synthesize({
          text: 'నమస్కారం',
          language: 'te',
          voice: 'te_IN-maya-medium',
        }),
      (err) => err.code === TTS_ERROR_CODES.PIPER_VOICE_NOT_ALLOWED,
    );
    await assert.rejects(
      () =>
        tts.synthesize({
          text: 'నమస్కారం',
          language: 'te',
          voice: 'af_bella',
        }),
      (err) => err.code === TTS_ERROR_CODES.LANGUAGE_VOICE_MISMATCH,
    );

    const kokoro = new KokoroTextToSpeech({
      baseUrl: 'http://127.0.0.1:9',
      cacheEnabled: false,
      retryOnce: false,
    });
    await assert.rejects(
      () =>
        kokoro.synthesize({
          text: 'hello',
          language: 'en',
          voice: 'te_IN-padmavathi-medium',
        }),
      (err) => err.code === TTS_ERROR_CODES.LANGUAGE_VOICE_MISMATCH,
    );
  });
});

test('cache keys never collide; cache hit skips second request; bounded', async () => {
  let hits = 0;
  await withFakePiper(
    defaultPiperHandler({
      onSynthesize: (_b, n) => {
        hits = n;
      },
    }),
    async (piperUrl) => {
      const shared = new BoundedTtsCache({ maxEntries: 3, maxBytes: 100_000 });
      const piper = new PiperTextToSpeech({
        baseUrl: piperUrl,
        cache: shared,
        retryOnce: false,
        maxConcurrent: 2,
      });
      const a = await piper.synthesize({
        text: 'నమస్కారం',
        language: 'te',
        voice: 'te_IN-padmavathi-medium',
      });
      const b = await piper.synthesize({
        text: 'నమస్కారం',
        language: 'te',
        voice: 'te_IN-padmavathi-medium',
      });
      assert.equal(hits, 1);
      assert.equal(b.cached, true);
      assert.deepEqual(a.audio, b.audio);

      const kokoroKey = BoundedTtsCache.buildKey({
        provider: 'kokoro-local',
        language: 'en',
        voice: 'af_bella',
        speed: 1,
        text: 'namaskaram',
      });
      const piperKey = BoundedTtsCache.buildKey({
        provider: 'piper-local',
        language: 'te',
        voice: 'te_IN-padmavathi-medium',
        speed: 1,
        text: 'namaskaram',
      });
      assert.notEqual(kokoroKey, piperKey);

      shared.set(kokoroKey, Buffer.alloc(100, 1));
      shared.set(piperKey, Buffer.alloc(100, 2));
      shared.set('k3', Buffer.alloc(100, 3));
      shared.set('k4', Buffer.alloc(100, 4));
      assert.ok(shared.map.size <= 3);
    },
  );
});

test('concurrency bounded; closed session ignored; failure preserves intent', async () => {
  const limiter = new TtsConcurrencyLimiter({ maxConcurrent: 1, maxPending: 1 });
  let released = 0;
  await withFakePiper(
    defaultPiperHandler({ hangMs: 30 }),
    async (baseUrl) => {
      const tts = new PiperTextToSpeech({
        baseUrl,
        limiter,
        cacheEnabled: false,
        retryOnce: false,
        requestTimeoutMs: 5000,
      });
      const p1 = tts.synthesize({ text: 'ఒకటి', language: 'te' }).finally(() => {
        released += 1;
      });
      const p2 = tts.synthesize({ text: 'రెండు', language: 'te' }).finally(() => {
        released += 1;
      });
      await assert.rejects(
        () => tts.synthesize({ text: 'మూడు', language: 'te' }),
        (err) => err.code === TTS_ERROR_CODES.QUEUE_FULL,
      );
      await Promise.all([p1, p2]);
      assert.equal(released, 2);

      await assert.rejects(
        () =>
          tts.synthesize({
            text: 'నాలుగు',
            language: 'te',
            metadata: { sessionClosed: true },
          }),
        (err) => err.code === TTS_ERROR_CODES.SESSION_CLOSED,
      );
    },
  );

  let kokoroCalled = false;
  const failingPiper = {
    async synthesize() {
      throw new TtsProviderError(
        TTS_ERROR_CODES.PIPER_CONNECT_FAILED,
        'down',
        { retryable: true },
      );
    },
  };
  const trackingKokoro = {
    async synthesize() {
      kokoroCalled = true;
      return { audio: Buffer.alloc(8), provider: 'kokoro-local' };
    },
  };
  const pipeline = new VoicePipeline({
    agent: new AdmissionsResponseEngine(),
    tts: new LanguageTtsRouter({
      englishProvider: trackingKokoro,
      teluguProvider: failingPiper,
    }),
  });
  const result = await pipeline.handleTranscript(
    { text: 'నాకు ఆసక్తి ఉంది', isFinal: true, language: 'te' },
    { metadata: {} },
  );
  assert.ok(result.reply);
  assert.ok(result.ttsError);
  assert.equal(kokoroCalled, false);
  assert.equal(result.audio, null);
});

test('OUTBOUND inherit + Telugu/English routing; msedge rejected; mock works', async () => {
  assert.throws(() => rejectLegacyMsEdge('msedge'), /no longer supported/);
  assert.throws(() => normalizeVoiceTtsProvider('msedge'), /no longer supported/);
  assert.throws(() => resolveOutboundTtsProvider('edge', 'mock'), /no longer supported/);
  assert.equal(resolveOutboundTtsProvider('inherit', 'mock'), 'mock');
  assert.equal(resolveOutboundTtsProvider('inherit', 'local'), 'local-quality');

  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
  assert.equal(pkg.dependencies['msedge-tts'], undefined);

  await withFakePiper(defaultPiperHandler(), async (piperUrl) => {
    const kokoroServer = http.createServer(async (req, res) => {
      if (req.url === '/v1/audio/voices') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ voices: ['af_bella'] }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(synthPcmTone({ durationSeconds: 0.25, sampleRate: 24000 }));
    });
    kokoroServer.listen(0, '127.0.0.1');
    await once(kokoroServer, 'listening');
    const kokoroUrl = `http://127.0.0.1:${kokoroServer.address().port}`;
    try {
      const config = getConfig({
        voiceTtsProvider: 'local',
        outbound: { ttsProvider: 'inherit' },
        kokoro: { baseUrl: kokoroUrl, defaultVoice: 'af_bella' },
        piper: { baseUrl: piperUrl, defaultVoice: 'te_IN-padmavathi-medium' },
        tts: { cacheEnabled: false },
      });

      const teOut = await synthesizeOutboundAudio(
        'మీ డెమో సెషన్ రేపు ఉంటుంది.',
        {
          language: 'te',
          voice: 'te_IN-padmavathi-medium',
          retryOnce: false,
        },
        config,
      );
      assert.equal(teOut.provider, 'piper-local');

      const enOut = await synthesizeOutboundAudio(
        'Your demo session is tomorrow.',
        { language: 'en', voice: 'af_bella', retryOnce: false },
        config,
      );
      assert.equal(enOut.provider, 'kokoro-local');

      // DTMF-style replies
      const teDtmf = await synthesizeOutboundAudio(
        'ధన్యవాదాలు! మీ ఆసక్తిని నమోదు చేసుకున్నాం.',
        { language: 'te', voice: 'te_IN-padmavathi-medium', retryOnce: false },
        config,
      );
      assert.equal(teDtmf.provider, 'piper-local');
      const enDtmf = await synthesizeOutboundAudio(
        'Thank you! We have noted that you are interested.',
        { language: 'en', voice: 'af_bella', retryOnce: false },
        config,
      );
      assert.equal(enDtmf.provider, 'kokoro-local');
    } finally {
      kokoroServer.close();
      await once(kokoroServer, 'close');
    }
  });

  const mock = createTextToSpeechProvider({ voiceTtsProvider: 'mock' });
  const mockSpeech = await mock.synthesize({
    text: 'hello',
    language: 'en',
  });
  assert.equal(mockSpeech.provider, 'mock-tts');

  const wav = synthWavTone({ durationSeconds: 1, sampleRate: 22050 });
  const converted = await wavToMulaw8k(wav);
  assert.ok(converted.audio.length > 7000 && converted.audio.length < 9000);
});
