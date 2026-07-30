import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import WebSocket from 'ws';
import { Repository } from '../src/database.js';
import { MockProvider } from '../src/providers/mock-provider.js';
import { createApp } from '../src/app.js';
import { getConfig } from '../src/config.js';
import { StreamSessionManager } from '../src/streaming/session-manager.js';
import { attachVoiceStreaming } from '../src/streaming/websocket-gateway.js';
import { STREAM_PATH } from '../src/streaming/constants.js';
import { AUDIO, MULAW_SILENCE } from '../src/streaming/constants.js';
import { logStreamEvent, sanitizeIp, classifyUserAgent } from '../src/streaming/stream-logger.js';
import { parseArgs } from '../scripts/parse-simulator-args.js';

const STREAM_SECRET = 'phase3c-stream-test-secret';
const API_TOKEN = 'must-not-appear-as-stream-secret';
const WEBHOOK_PATH = '/webhooks/smartping/call-status';

async function withServer(run, overrides = {}) {
  const repository = new Repository(':memory:');
  const logs = [];
  const config = getConfig({
    providerName: 'mock',
    exposureMode: 'full',
    webhookSecret: 'webhook-test-secret',
    smartPing: {
      dryRun: true,
      liveCallsEnabled: false,
      storeAudio: false,
      apiToken: API_TOKEN,
      streamAuthMode: 'disabled',
      streamSharedSecret: STREAM_SECRET,
      streamUrl: `ws://127.0.0.1${STREAM_PATH}`,
      webhookPath: WEBHOOK_PATH,
      webhookAuthMode: 'validation-only',
      maxConnections: 5,
      maxMessageBytes: 4096,
      idleTimeoutMs: 60_000,
      ...overrides.smartPing,
    },
    ...overrides,
  });
  config.exposureMode = overrides.exposureMode ?? config.exposureMode;
  config.smartPing = {
    ...config.smartPing,
    ...(overrides.smartPing ?? {}),
  };
  config.outbound = {
    ...(config.outbound || {}),
    dialerLive: overrides.outbound?.dialerLive === true,
  };

  const provider = new MockProvider();
  const sessionManager = new StreamSessionManager({
    repository,
    config: config.smartPing,
  });
  const acceptingConnections = { current: true };
  const server = http.createServer(
    createApp({ repository, provider, config, sessionManager }),
  );
  attachVoiceStreaming({
    server,
    sessionManager,
    config: config.smartPing,
    acceptingConnections,
    logSink: (line) => logs.push(line),
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  const wsUrl = `ws://127.0.0.1:${port}${STREAM_PATH}`;
  try {
    await run({ baseUrl, wsUrl, config, repository, sessionManager, logs });
  } finally {
    acceptingConnections.current = false;
    sessionManager.closeAll('test_done');
    server.close();
    await once(server, 'close');
    repository.close();
  }
}

function connect(wsUrl, headers = {}) {
  const ws = new WebSocket(wsUrl, { headers });
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
    ws.once('unexpected-response', (_req, response) => {
      reject(
        Object.assign(new Error(`HTTP ${response.statusCode}`), {
          statusCode: response.statusCode,
        }),
      );
    });
  });
}

function mulawB64() {
  return Buffer.alloc(AUDIO.chunkBytes, MULAW_SILENCE).toString('base64');
}

test('provider-compatible mode accepts upgrade without bearer on exact route', async () => {
  await withServer(
    async ({ baseUrl, wsUrl }) => {
      const home = await fetch(`${baseUrl}/`);
      assert.equal(home.status, 404);
      const api = await fetch(`${baseUrl}/api/leads`);
      assert.equal(api.status, 404);
      const plain = await fetch(`${baseUrl}${STREAM_PATH}`);
      assert.equal(plain.status, 404);

      const ws = await connect(wsUrl);
      assert.equal(ws.readyState, WebSocket.OPEN);
      ws.close();
    },
    {
      exposureMode: 'stream-only',
      smartPing: {
        streamAuthMode: 'provider-compatible',
        streamSharedSecret: STREAM_SECRET,
        liveCallsEnabled: false,
        dryRun: true,
      },
    },
  );
});

test('required mode still rejects missing and invalid bearer', async () => {
  await withServer(
    async ({ wsUrl }) => {
      await assert.rejects(() => connect(wsUrl), /HTTP 401/);
      await assert.rejects(
        () => connect(wsUrl, { Authorization: 'Bearer wrong' }),
        /HTTP 401/,
      );
      const ws = await connect(wsUrl, {
        Authorization: `Bearer ${STREAM_SECRET}`,
      });
      ws.close();
    },
    {
      exposureMode: 'stream-only',
      smartPing: {
        streamAuthMode: 'required',
        streamSharedSecret: STREAM_SECRET,
      },
    },
  );
});

test('incorrect websocket paths are rejected', async () => {
  await withServer(
    async ({ baseUrl }) => {
      const badUrl = baseUrl.replace('http', 'ws') + '/ws/voice/other';
      await assert.rejects(() => connect(badUrl), /./);
    },
    {
      exposureMode: 'stream-only',
      smartPing: { streamAuthMode: 'provider-compatible' },
    },
  );
});

test('valid protocol events are accepted and invalid ones rejected safely', async () => {
  await withServer(
    async ({ wsUrl, logs }) => {
      const ws = await connect(wsUrl);
      const replies = [];
      ws.on('message', (data) => replies.push(JSON.parse(String(data))));

      ws.send(JSON.stringify({ event: 'connected', protocol: 'Call', version: '1.0.0' }));
      ws.send(
        JSON.stringify({
          event: 'start',
          sequenceNumber: '1',
          start: {
            streamSid: 'MZtest1',
            callSid: 'CAtest1',
            mediaFormat: {
              encoding: AUDIO.encoding,
              sampleRate: AUDIO.sampleRate,
              channels: 1,
            },
          },
        }),
      );
      ws.send(
        JSON.stringify({
          event: 'media',
          sequenceNumber: '2',
          streamSid: 'MZtest1',
          media: { payload: mulawB64(), track: 'inbound', chunk: '1', timestamp: '0' },
        }),
      );
      ws.send(JSON.stringify({ event: 'not-a-real-event' }));
      ws.send('{not-json');

      await new Promise((resolve) => setTimeout(resolve, 150));
      const errorCodes = replies
        .filter((item) => item.event === 'error')
        .map((item) => item.error?.code);
      assert.ok(errorCodes.includes('unknown_event'));
      assert.ok(errorCodes.includes('invalid_json'));

      const joined = logs.join('\n');
      assert.equal(joined.includes(STREAM_SECRET), false);
      assert.equal(joined.includes(API_TOKEN), false);
      assert.equal(joined.includes(mulawB64()), false);
      assert.equal(joined.includes('+91'), false);
      assert.match(joined, /"protocolEvent":"connected"/);
      assert.match(joined, /"protocolEvent":"start"/);
      assert.match(joined, /"protocolEvent":"media"/);

      ws.close();
    },
    {
      exposureMode: 'stream-only',
      smartPing: { streamAuthMode: 'provider-compatible' },
    },
  );
});

test('oversized websocket payloads are rejected', async () => {
  await withServer(
    async ({ wsUrl }) => {
      const ws = await connect(wsUrl);
      const replies = [];
      ws.on('message', (data) => replies.push(JSON.parse(String(data))));
      const huge = 'A'.repeat(5000);
      ws.send(JSON.stringify({ event: 'connected', protocol: huge }));
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.ok(
        replies.some((item) => item.error?.code === 'payload_too_large') ||
          ws.readyState === WebSocket.CLOSED ||
          ws.readyState === WebSocket.CLOSING,
      );
    },
    {
      exposureMode: 'stream-only',
      smartPing: {
        streamAuthMode: 'provider-compatible',
        maxMessageBytes: 1024,
      },
    },
  );
});

test('idle connections are closed', async () => {
  await withServer(
    async ({ wsUrl }) => {
      const ws = await connect(wsUrl);
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('idle close timeout')), 2500);
        ws.once('close', (code) => {
          clearTimeout(timer);
          assert.equal(code, 1001);
          resolve();
        });
      });
    },
    {
      exposureMode: 'stream-only',
      smartPing: {
        streamAuthMode: 'provider-compatible',
        idleTimeoutMs: 400,
      },
    },
  );
});

test('call-status webhook accepts valid JSON and rejects bad content type', async () => {
  await withServer(
    async ({ baseUrl, logs }) => {
      const badType = await fetch(`${baseUrl}${WEBHOOK_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: 'nope',
      });
      assert.equal(badType.status, 415);

      const payload = {
        event_id: 'evt-1',
        call_sid: 'CA123',
        status: 'completed',
        phone_number: '+919811112222',
      };
      const ok = await fetch(`${baseUrl}${WEBHOOK_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = await ok.json();
      assert.equal(ok.status, 200);
      assert.equal(body.ok, true);
      assert.equal(body.duplicate, false);

      const dup = await fetch(`${baseUrl}${WEBHOOK_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const dupBody = await dup.json();
      assert.equal(dup.status, 200);
      assert.equal(dupBody.duplicate, true);

      const joined = logs.join('\n');
      assert.equal(JSON.stringify(body).includes('+919811112222'), false);
      assert.equal(JSON.stringify(dupBody).includes('+919811112222'), false);
      assert.equal(joined.includes('+919811112222'), false);

      const healthz = await fetch(`${baseUrl}/healthz`);
      const hz = await healthz.json();
      assert.equal(hz.liveCallsEnabled, false);
    },
    {
      exposureMode: 'stream-only',
      smartPing: {
        streamAuthMode: 'provider-compatible',
        webhookAuthMode: 'validation-only',
        liveCallsEnabled: false,
      },
    },
  );
});

test('shared-secret webhook mode rejects missing secret', async () => {
  await withServer(
    async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}${WEBHOOK_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ event_id: 'x', status: 'ringing' }),
      });
      assert.equal(response.status, 401);
    },
    {
      exposureMode: 'stream-only',
      smartPing: {
        streamAuthMode: 'provider-compatible',
        webhookAuthMode: 'shared-secret',
        webhookSharedSecret: 'webhook-shared-test',
      },
    },
  );
});

test('privacy-safe logger never emits credentials phones or audio', () => {
  const lines = [];
  logStreamEvent(
    {
      event: 'ws_protocol',
      route: STREAM_PATH,
      auth: 'accepted',
      authReason: 'provider_compatible',
      connectionId: 'abc',
      protocolEvent: 'media',
      ...sanitizeIp('203.0.113.50'),
      ua: classifyUserAgent('curl/8.5.0'),
    },
    (line) => lines.push(line),
  );
  const text = lines.join('\n');
  assert.equal(text.includes('Authorization'), false);
  assert.equal(text.includes('Bearer'), false);
  assert.equal(text.includes('+91'), false);
  assert.equal(text.includes('203.0.113.50'), false);
  assert.match(text, /203\.0\.x\.x/);
  assert.match(text, /"ua":"curl"/);
});

test('live calls remain disabled in public settings flags', async () => {
  await withServer(async ({ config }) => {
    assert.equal(config.smartPing.liveCallsEnabled, false);
    assert.equal(config.smartPing.dryRun, true);
    assert.equal(config.providerName, 'mock');
  });
});

test('simulator CLI supports --ws-auth for required mode', () => {
  const parsed = parseArgs([
    '--url',
    'wss://example.up.railway.app/ws/voice/smartping',
    '--token',
    'abc',
    '--ws-auth',
  ]);
  assert.equal(parsed.wsAuth, true);
  assert.equal(parsed.token, 'abc');
});
