import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { getConfig } from '../src/config.js';
import { Repository } from '../src/database.js';
import { createProvider } from '../src/providers/index.js';
import { createApp } from '../src/app.js';
import { StreamSessionManager } from '../src/streaming/session-manager.js';
import { OutboundPromptStore } from '../src/streaming/outbound/prompt-store.js';
import {
  normalizeOutboundPhone,
  normalizeOutboundMessage,
  normalizeOutboundVoice,
  normalizeRepeatCount,
} from '../src/streaming/outbound/phone.js';
import { concatMulawWithRepeats, pcm16leMonoToMulaw, mulawToWavBase64 } from '../src/streaming/tts/mulaw-encode.js';
import { AUDIO } from '../src/streaming/constants.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const SECRET = 'outbound-dialer-secret-token-never-leak';
const PHONE = '9876544410';

function makeConfig(overrides = {}) {
  const config = getConfig({
    exposureMode: 'full',
    databasePath: ':memory:',
    smartPing: {
      apiToken: SECRET,
      baseUrl: 'https://voicecpt.apps.smartpingcc.io',
      didNumber: '917444124324',
      dryRun: true,
      liveCallsEnabled: false,
      singleCallEnabled: false,
      playbackMode: 'fixed-welcome',
      streamUrl: 'wss://example.invalid/ws/voice/smartping',
      ...(overrides.smartPing || {}),
    },
    outbound: {
      dialerLive: false,
      ...(overrides.outbound || {}),
    },
    ...overrides,
  });
  config.exposureMode = overrides.exposureMode || 'full';
  // Ignore process.env OUTBOUND_DIALER_LIVE unless a test opts in.
  config.outbound = {
    ...(config.outbound || {}),
    dialerLive: overrides.outbound?.dialerLive === true,
  };
  return config;
}

async function withServer(run, overrides = {}) {
  const config = makeConfig(overrides);
  const repository = new Repository(':memory:');
  const provider = createProvider(config);
  const promptDir = mkdtempSync(path.join(tmpdir(), 'outbound-prompts-'));
  const promptStore = new OutboundPromptStore({ directory: promptDir, ttlMs: 60_000 });
  const sessionManager = new StreamSessionManager({
    repository,
    config: config.smartPing,
    promptStore,
  });
  const server = http.createServer(
    createApp({
      repository,
      provider,
      config,
      sessionManager,
      promptStore,
    }),
  );
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  try {
    await run({ base, repository, sessionManager, promptStore, config });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    repository.close();
    rmSync(promptDir, { recursive: true, force: true });
  }
}

async function postJson(base, pathName, body) {
  const response = await fetch(`${base}${pathName}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { response, body: await response.json().catch(() => ({})) };
}

test('phone normalization accepts 10 digits and strips 91 prefix', () => {
  assert.equal(normalizeOutboundPhone(PHONE).ok, true);
  assert.equal(normalizeOutboundPhone(PHONE).phone, PHONE);
  assert.equal(normalizeOutboundPhone(`91${PHONE}`).phone, PHONE);
  assert.equal(normalizeOutboundPhone('+91' + PHONE).phone, PHONE);
  assert.equal(normalizeOutboundPhone('123').ok, false);
  assert.equal(normalizeOutboundMessage('').ok, false);
  assert.equal(normalizeOutboundMessage('Hello').ok, true);
  assert.equal(normalizeRepeatCount(9), 5);
  assert.equal(normalizeRepeatCount(0), 1);
  assert.equal(normalizeOutboundVoice('en-IN-PrabhatNeural').voice, 'en-IN-PrabhatNeural');
  assert.equal(normalizeOutboundVoice('te-IN-ShrutiNeural').voice, 'te-IN-ShrutiNeural');
  assert.equal(normalizeOutboundVoice('te-IN-MohanNeural').voice, 'te-IN-MohanNeural');
  assert.equal(normalizeOutboundVoice('en-US-JennyNeural').ok, false);
  assert.equal(normalizeOutboundVoice('').voice, 'en-IN-NeerjaNeural');
});

test('mulaw encode rejects silence and concat respects repeat', () => {
  const pcm = Buffer.alloc(1600);
  for (let i = 0; i < 800; i += 1) pcm.writeInt16LE(i % 2 === 0 ? 4000 : -4000, i * 2);
  const encoded = pcm16leMonoToMulaw(pcm);
  assert.ok(encoded.byteLength > 0);
  assert.ok(encoded.energyRatio > 0.02);
  const once = concatMulawWithRepeats(encoded.bytes, 1);
  const twice = concatMulawWithRepeats(encoded.bytes, 2);
  assert.ok(twice.length > once.length);
  const wav = mulawToWavBase64(once);
  assert.equal(wav.mimeType, 'audio/wav');
  assert.ok(wav.base64.length > 100);
  assert.equal(Buffer.from(wav.base64, 'base64').subarray(0, 4).toString('ascii'), 'RIFF');
});

test('outbound health and preview never leak secrets or dial', async () => {
  await withServer(async ({ base }) => {
    const health = await fetch(`${base}/api/outbound/health`).then(async (r) => ({
      response: r,
      body: await r.json(),
    }));
    assert.equal(health.response.status, 200);
    assert.equal(health.body.liveGatesOpen, false);
    assert.equal(health.body.liveCallActionAvailable, false);
    assert.equal(health.body.voiceOptions?.length, 4);
    assert.equal(health.body.languageOptions?.length, 2);
    assert.ok(health.body.voiceOptions.some((v) => v.id === 'te-IN-ShrutiNeural'));
    assert.ok(health.body.voiceOptions.some((v) => v.id === 'te-IN-MohanNeural'));
    const serializedHealth = JSON.stringify(health.body);
    assert.equal(serializedHealth.includes(SECRET), false);

    const preview = await postJson(base, '/api/outbound/preview', {
      phoneNumber: PHONE,
      message: 'Hello from outbound dialer preview.',
      repeatCount: 2,
      voice: 'en-IN-NeerjaNeural',
    });
    assert.equal(preview.response.status, 200);
    assert.equal(preview.body.networkRequestMade, false);
    assert.equal(preview.body.phoneMasked, '••••4410');
    assert.equal(preview.body.repeatCount, 2);
    assert.equal(preview.body.voice, 'en-IN-NeerjaNeural');
    if (preview.body.audio?.estimated === false) {
      assert.equal(preview.body.audio.voice, 'en-IN-NeerjaNeural');
      assert.ok(preview.body.audio.preview?.base64);
    }
    const serialized = JSON.stringify(preview.body);
    assert.equal(serialized.includes(SECRET), false);
    assert.equal(serialized.includes(PHONE), false);

    const badVoice = await postJson(base, '/api/outbound/preview', {
      phoneNumber: PHONE,
      message: 'Hello',
      voice: 'en-US-JennyNeural',
    });
    assert.equal(badVoice.response.status, 400);
    assert.equal(badVoice.body.code, 'invalid_voice');
  });
});

test('live outbound call blocked when gates are off', async () => {
  await withServer(async ({ base }) => {
    const denied = await postJson(base, '/api/outbound/call', {
      phoneNumber: PHONE,
      message: 'Should not dial.',
      repeatCount: 1,
      confirm: true,
    });
    assert.equal(denied.response.status, 403);
    assert.equal(denied.body.networkRequestMade == null || denied.body.networkRequestMade === false, true);

    const noConfirm = await postJson(base, '/api/outbound/call', {
      phoneNumber: PHONE,
      message: 'Should not dial.',
      confirm: false,
    });
    assert.equal(noConfirm.response.status, 403);
  });
});

test('custom outbound prompt plays once across duplicate start', async () => {
  await withServer(async ({ sessionManager, promptStore }) => {
    const pcm = Buffer.alloc(1600);
    for (let i = 0; i < 800; i += 1) pcm.writeInt16LE(3000, i * 2);
    const encoded = pcm16leMonoToMulaw(pcm);
    const prompt = promptStore.create({
      phoneMasked: '••••4410',
      messageLength: 12,
      repeatCount: 2,
      mulawBytes: encoded.bytes,
      durationSeconds: encoded.durationSeconds,
      voice: 'test',
      provider: 'test',
    });

    const ws = {
      readyState: 1,
      sent: [],
      send(payload) {
        this.sent.push(JSON.parse(payload));
      },
    };
    const session = sessionManager.attachSocket(ws);
    const first = await sessionManager.handleNormalizedEvent(session, {
      event: 'start',
      sequenceNumber: '1',
      streamSid: 'MZoutbound1',
      callSid: 'CAoutbound1',
      mediaFormat: {
        encoding: AUDIO.encoding,
        sampleRate: AUDIO.sampleRate,
        channels: 1,
      },
      customParameters: { app_call_id: prompt.appCallId },
      tracks: ['inbound'],
    });
    const second = await sessionManager.handleNormalizedEvent(session, {
      event: 'start',
      sequenceNumber: '2',
      streamSid: 'MZoutbound1',
      callSid: 'CAoutbound1',
      mediaFormat: {
        encoding: AUDIO.encoding,
        sampleRate: AUDIO.sampleRate,
        channels: 1,
      },
      customParameters: { app_call_id: prompt.appCallId },
      tracks: ['inbound'],
    });
    assert.equal(first.playback.mode, 'outbound-tts');
    assert.ok(first.playback.enqueuedChunks > 0);
    assert.equal(first.playback.repeatCount, 2);
    assert.equal(second.playback.skippedDuplicate, true);
    assert.equal(second.playback.enqueuedChunks, 0);
    sessionManager.closeAll('test_done');
  });
});

test('stream-only mode blocks outbound APIs', async () => {
  await withServer(
    async ({ base }) => {
      const health = await fetch(`${base}/api/outbound/health`);
      assert.equal(health.status, 404);
    },
    { exposureMode: 'stream-only' },
  );
});

test('dialer live opens gates and stream-only dialer surface', async () => {
  await withServer(
    async ({ base }) => {
      const health = await fetch(`${base}/api/outbound/health`).then(async (r) => ({
        response: r,
        body: await r.json(),
      }));
      assert.equal(health.response.status, 200);
      assert.equal(health.body.dialerLive, true);
      assert.equal(health.body.liveGatesOpen, true);
      assert.equal(health.body.credentialsReady, true);

      const deniedNoConfirm = await postJson(base, '/api/outbound/call', {
        phoneNumber: PHONE,
        message: 'Dialer live still needs confirm.',
        confirm: false,
      });
      assert.equal(deniedNoConfirm.response.status, 403);
    },
    {
      exposureMode: 'stream-only',
      outbound: { dialerLive: true },
    },
  );
});
