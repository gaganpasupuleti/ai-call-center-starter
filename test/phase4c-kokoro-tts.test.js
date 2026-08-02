import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { KokoroTextToSpeech } from '../src/streaming/tts/kokoro-client.js';
import { LanguageTtsRouter } from '../src/streaming/tts/language-router.js';
import { BoundedTtsCache } from '../src/streaming/tts/bounded-tts-cache.js';
import { TtsConcurrencyLimiter } from '../src/streaming/tts/tts-concurrency.js';
import {
  pcm24kToMulaw8k,
  synthPcmTone,
} from '../src/streaming/tts/audio-normalizer.js';
import {
  createTextToSpeechProvider,
  synthesizeOutboundAudio,
  normalizeVoiceTtsProvider,
} from '../src/streaming/tts/tts-provider-factory.js';
import { TTS_ERROR_CODES, TtsProviderError } from '../src/streaming/tts/errors.js';
import { VoicePipeline } from '../src/streaming/ai/pipeline.js';
import { AdmissionsResponseEngine } from '../src/streaming/response/response-engine.js';
import { MockTextToSpeech } from '../src/streaming/ai/mock-tts.js';
import { getConfig } from '../src/config.js';

async function withFakeKokoro(handler, run) {
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

test('1-5 speech request body and PCM→μ-law conversion', async () => {
  let seenBody = null;
  await withFakeKokoro(async (req, res) => {
    if (req.url === '/v1/audio/voices') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ voices: ['af_bella', 'af_sky'] }));
      return;
    }
    const raw = await readBody(req);
    seenBody = JSON.parse(raw.toString('utf8'));
    const pcm = synthPcmTone({ durationSeconds: 1, sampleRate: 24000 });
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.end(pcm);
  }, async (baseUrl) => {
    const tts = new KokoroTextToSpeech({
      baseUrl,
      defaultVoice: 'af_bella',
      cacheEnabled: false,
      retryOnce: false,
    });
    const result = await tts.synthesize({
      text: 'Certainly. We will send the course details to your WhatsApp number.',
      language: 'en',
      voice: 'af_bella',
      speed: 1.0,
    });
    assert.equal(seenBody.model, 'kokoro');
    assert.equal(seenBody.voice, 'af_bella');
    assert.equal(seenBody.response_format, 'pcm');
    assert.equal(seenBody.speed, 1);
    assert.equal(result.provider, 'kokoro-local');
    assert.equal(result.format.encoding, 'mulaw');
    assert.equal(result.format.sampleRate, 8000);
    // ~1 second μ-law ≈ 8000 bytes (± resampling)
    assert.ok(result.audio.length > 7000 && result.audio.length < 9000);
    assert.ok(Math.abs(result.durationSeconds - 1) < 0.2);
  });
});

test('6-8 HTTP errors, empty and oversized responses', async () => {
  await withFakeKokoro((req, res) => {
    res.writeHead(500);
    res.end('nope');
  }, async (baseUrl) => {
    const tts = new KokoroTextToSpeech({
      baseUrl,
      cacheEnabled: false,
      retryOnce: false,
    });
    await assert.rejects(
      () => tts.synthesize({ text: 'hello', language: 'en' }),
      (err) => err.code === TTS_ERROR_CODES.HTTP_ERROR,
    );
  });

  await withFakeKokoro((req, res) => {
    res.writeHead(200);
    res.end(Buffer.alloc(0));
  }, async (baseUrl) => {
    const tts = new KokoroTextToSpeech({
      baseUrl,
      cacheEnabled: false,
      retryOnce: false,
    });
    await assert.rejects(
      () => tts.synthesize({ text: 'hello', language: 'en' }),
      (err) => err.code === TTS_ERROR_CODES.EMPTY_RESPONSE,
    );
  });

  await withFakeKokoro((req, res) => {
    res.writeHead(200);
    res.end(Buffer.alloc(100));
  }, async (baseUrl) => {
    const tts = new KokoroTextToSpeech({
      baseUrl,
      cacheEnabled: false,
      retryOnce: false,
      maxPcmBytes: 10,
    });
    await assert.rejects(
      () => tts.synthesize({ text: 'hello', language: 'en' }),
      (err) => err.code === TTS_ERROR_CODES.RESPONSE_TOO_LARGE,
    );
  });
});

test('9 request timeout aborts', async () => {
  await withFakeKokoro((_req, res) => {
    // never respond
    setTimeout(() => res.end(), 5000);
  }, async (baseUrl) => {
    const tts = new KokoroTextToSpeech({
      baseUrl,
      requestTimeoutMs: 50,
      cacheEnabled: false,
      retryOnce: false,
    });
    await assert.rejects(
      () => tts.synthesize({ text: 'hello', language: 'en' }),
      (err) =>
        err.code === TTS_ERROR_CODES.REQUEST_TIMEOUT ||
        err.code === TTS_ERROR_CODES.CONNECT_FAILED,
    );
  });
});

test('10 conversion timeout or failure is controlled', async () => {
  await assert.rejects(
    () =>
      pcm24kToMulaw8k(synthPcmTone({ durationSeconds: 3 }), {
        timeoutMs: 1,
      }),
    (err) =>
      err.code === TTS_ERROR_CODES.CONVERSION_TIMEOUT ||
      err.code === TTS_ERROR_CODES.CONVERSION_FAILED,
  );
});

test('11-12 invalid voice and text limit', async () => {
  const tts = new KokoroTextToSpeech({
    baseUrl: 'http://127.0.0.1:9',
    cacheEnabled: false,
  });
  await assert.rejects(
    () => tts.synthesize({ text: 'hi', voice: 'not_a_voice', language: 'en' }),
    (err) => err.code === TTS_ERROR_CODES.VOICE_NOT_ALLOWED,
  );
  await assert.rejects(
    () =>
      tts.synthesize({
        text: 'x'.repeat(601),
        voice: 'af_bella',
        language: 'en',
      }),
    (err) => err.code === TTS_ERROR_CODES.TEXT_TOO_LONG,
  );
});

test('13-15 English routes; Telugu blocked; no msedge fallback', async () => {
  const english = {
    async synthesize(input) {
      return {
        audio: Buffer.from([0xff]),
        format: { encoding: 'mulaw', sampleRate: 8000, channels: 1 },
        provider: 'kokoro-local',
        voice: 'af_bella',
        language: input.language,
        cached: false,
      };
    },
  };
  const router = new LanguageTtsRouter({ englishProvider: english });
  const en = await router.synthesize({ text: 'We will call you tomorrow.', language: 'en' });
  assert.equal(en.provider, 'kokoro-local');
  await assert.rejects(
    () => router.synthesize({ text: 'రేపు కాల్ చేస్తాము.', language: 'te' }),
    (err) => err.code === TTS_ERROR_CODES.LANGUAGE_NOT_CONFIGURED,
  );
  // Ensure factory kokoro path does not silently become msedge
  assert.equal(normalizeVoiceTtsProvider('kokoro'), 'kokoro');
  assert.throws(() => normalizeVoiceTtsProvider('openai'));
});

test('16-21 cache behaviour', async () => {
  let hits = 0;
  await withFakeKokoro(async (req, res) => {
    hits += 1;
    const pcm = synthPcmTone({ durationSeconds: 0.25 });
    res.writeHead(200);
    res.end(pcm);
  }, async (baseUrl) => {
    const cache = new BoundedTtsCache({
      enabled: true,
      maxEntries: 2,
      maxBytes: 50_000,
      ttlMs: 60_000,
    });
    const tts = new KokoroTextToSpeech({
      baseUrl,
      cache,
      retryOnce: false,
    });
    await tts.synthesize({ text: 'Hello world', voice: 'af_bella', language: 'en' });
    await tts.synthesize({ text: 'Hello world', voice: 'af_bella', language: 'en' });
    assert.equal(hits, 1);
    assert.equal(cache.stats.hits, 1);

    await tts.synthesize({ text: 'Hello world', voice: 'af_sky', language: 'en' });
    assert.equal(hits, 2);

    const tts2 = new KokoroTextToSpeech({
      baseUrl,
      cache,
      retryOnce: false,
      defaultSpeed: 1.1,
    });
    await tts2.synthesize({
      text: 'Hello world',
      voice: 'af_bella',
      language: 'en',
      speed: 1.1,
    });
    assert.equal(hits, 3);

    // entry limit
    const tiny = new BoundedTtsCache({ maxEntries: 1, maxBytes: 1_000_000 });
    tiny.set('a', Buffer.alloc(10));
    tiny.set('b', Buffer.alloc(10));
    assert.equal(tiny.size(), 1);
    assert.equal(tiny.get('a'), null);

    // byte limit
    const bytes = new BoundedTtsCache({ maxEntries: 10, maxBytes: 20 });
    bytes.set('a', Buffer.alloc(15));
    bytes.set('b', Buffer.alloc(15));
    assert.ok(bytes.size() <= 1);

    // TTL
    const ttl = new BoundedTtsCache({ ttlMs: 10, maxEntries: 5 });
    ttl.set('x', Buffer.alloc(8));
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(ttl.get('x'), null);
  });
});

test('22-23 concurrency and pending queue', async () => {
  const limiter = new TtsConcurrencyLimiter({ maxConcurrent: 1, maxPending: 1 });
  let released = false;
  const first = limiter.run(
    () =>
      new Promise((resolve) => {
        const wait = setInterval(() => {
          if (released) {
            clearInterval(wait);
            resolve('ok');
          }
        }, 5);
      }),
  );
  await new Promise((r) => setTimeout(r, 10));
  const second = limiter.run(async () => 'second');
  await assert.rejects(
    () => limiter.run(async () => 'third'),
    (err) => err.code === TTS_ERROR_CODES.QUEUE_FULL,
  );
  released = true;
  assert.equal(await first, 'ok');
  assert.equal(await second, 'second');
});

test('24 closed session flag', async () => {
  await withFakeKokoro((req, res) => {
    res.writeHead(200);
    res.end(synthPcmTone({ durationSeconds: 0.1 }));
  }, async (baseUrl) => {
    const tts = new KokoroTextToSpeech({
      baseUrl,
      cacheEnabled: false,
      retryOnce: false,
    });
    await assert.rejects(
      () =>
        tts.synthesize({
          text: 'hi',
          language: 'en',
          metadata: { sessionClosed: true },
        }),
      (err) => err.code === TTS_ERROR_CODES.SESSION_CLOSED,
    );
  });
});

test('25-28 pipeline Kokoro audio, actions, failure preserves decision, mock works', async () => {
  await withFakeKokoro((req, res) => {
    res.writeHead(200);
    res.end(synthPcmTone({ durationSeconds: 0.2 }));
  }, async (baseUrl) => {
    const config = getConfig({
      voiceTtsProvider: 'kokoro',
      kokoro: { baseUrl, defaultVoice: 'af_bella' },
      tts: { cacheEnabled: false },
    });
    const tts = createTextToSpeechProvider(config, { retryOnce: false });
    // inject no-retry on underlying
    const pipeline = new VoicePipeline({
      agent: new AdmissionsResponseEngine(),
      tts,
      defaultVoice: 'af_bella',
    });
    const ok = await pipeline.handleTranscript(
      { text: 'send me the details', isFinal: true, language: 'en' },
      { metadata: {}, streamSid: 'MZ1' },
    );
    assert.equal(ok.reply.intent, 'SEND_DETAILS');
    assert.ok(ok.audio?.length > 0);
    assert.equal(ok.tts.provider, 'kokoro-local');
    assert.ok(ok.actions.some((a) => a.type === 'create_follow_up'));

    const failPipeline = new VoicePipeline({
      agent: new AdmissionsResponseEngine(),
      tts: {
        async synthesize() {
          throw new TtsProviderError(TTS_ERROR_CODES.CONNECT_FAILED, 'down', {
            retryable: true,
          });
        },
      },
    });
    const failed = await failPipeline.handleTranscript(
      { text: 'transfer the call', isFinal: true },
      { metadata: {} },
    );
    assert.equal(failed.reply.intent, 'HUMAN_AGENT');
    assert.equal(failed.audio, null);
    assert.equal(failed.ttsError.code, TTS_ERROR_CODES.CONNECT_FAILED);
    assert.deepEqual(failed.actions[0], {
      type: 'transfer_queue',
      queue: 'admissions',
    });
  });

  const mockPipeline = new VoicePipeline({
    agent: new AdmissionsResponseEngine(),
    tts: new MockTextToSpeech(),
  });
  const mock = await mockPipeline.handleTranscript({
    text: 'book a demo',
    isFinal: true,
  });
  assert.ok(mock.audio);
  assert.equal(mock.tts.provider, 'mock-tts');
});

test('35 Kokoro outbound prompt mode with fake server', async () => {
  await withFakeKokoro((req, res) => {
    res.writeHead(200);
    res.end(synthPcmTone({ durationSeconds: 0.15 }));
  }, async (baseUrl) => {
    const result = await synthesizeOutboundAudio(
      'Hello from outbound dialer.',
      { voice: 'af_bella', language: 'en', provider: 'kokoro' },
      {
        voiceTtsProvider: 'kokoro',
        outbound: { ttsProvider: 'kokoro' },
        kokoro: { baseUrl, defaultVoice: 'af_bella' },
        tts: { cacheEnabled: false },
      },
    );
    assert.equal(result.provider, 'kokoro-local');
    assert.ok(result.bytes.length > 0);
  });
});

test('config rejects unknown VOICE_TTS_PROVIDER', () => {
  assert.throws(() => getConfig({ voiceTtsProvider: 'elevenlabs' }));
  const cfg = getConfig({ voiceTtsProvider: 'mock' });
  assert.equal(cfg.voiceTtsProvider, 'mock');
});
