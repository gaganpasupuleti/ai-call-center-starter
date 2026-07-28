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
import { executeVoicebotCall } from '../src/streaming/smartping/request-builder.js';
import { parseArgs } from '../scripts/parse-simulator-args.js';

const STREAM_SECRET = 'railway-stream-test-secret-phase3b';
const API_TOKEN = 'should-never-be-used-as-stream-secret';

async function withServer(run, overrides = {}) {
  const repository = new Repository(':memory:');
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
      ...overrides.smartPing,
    },
    ...overrides,
  });
  // Preserve nested smartPing merges for tests.
  config.exposureMode = overrides.exposureMode ?? config.exposureMode;
  config.smartPing = {
    ...config.smartPing,
    ...(overrides.smartPing ?? {}),
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
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  const wsUrl = `ws://127.0.0.1:${port}${STREAM_PATH}`;
  try {
    await run({ baseUrl, wsUrl, config, repository, sessionManager });
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
      reject(Object.assign(new Error(`HTTP ${response.statusCode}`), {
        statusCode: response.statusCode,
      }));
    });
  });
}

test('/healthz contains no secrets and reports live calls disabled', async () => {
  await withServer(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/healthz`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(body, {
      status: 'ok',
      service: 'smartping-voice-stream',
      liveCallsEnabled: false,
    });
    const serialized = JSON.stringify(body);
    assert.equal(serialized.includes(STREAM_SECRET), false);
    assert.equal(serialized.includes(API_TOKEN), false);
    assert.equal(serialized.includes('DATABASE_PATH'), false);
  });
});

test('stream-only mode blocks dashboard and api, permits healthz and websocket', async () => {
  await withServer(
    async ({ baseUrl, wsUrl }) => {
      const healthz = await fetch(`${baseUrl}/healthz`);
      assert.equal(healthz.status, 200);

      const home = await fetch(`${baseUrl}/`);
      assert.equal(home.status, 404);

      const api = await fetch(`${baseUrl}/api/leads`);
      assert.equal(api.status, 404);

      const settings = await fetch(`${baseUrl}/api/settings`);
      assert.equal(settings.status, 404);

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
        apiToken: API_TOKEN,
        dryRun: true,
        liveCallsEnabled: false,
      },
    },
  );
});

test('required websocket auth rejects missing and incorrect tokens', async () => {
  await withServer(
    async ({ wsUrl }) => {
      await assert.rejects(() => connect(wsUrl), /HTTP 401/);
      await assert.rejects(
        () => connect(wsUrl, { Authorization: 'Bearer wrong-token' }),
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
        apiToken: API_TOKEN,
      },
    },
  );
});

test('local full mode still works and dry-run prevents network calls', async () => {
  await withServer(async ({ baseUrl, config }) => {
    const home = await fetch(`${baseUrl}/`);
    assert.equal(home.status, 200);
    const leads = await fetch(`${baseUrl}/api/leads`);
    assert.equal(leads.status, 200);
    assert.equal(config.smartPing.liveCallsEnabled, false);

    let fetched = false;
    const result = await executeVoicebotCall(
      {
        ...config.smartPing,
        baseUrl: 'https://smartping.example',
        didNumber: '08000000000',
        dryRun: true,
        liveCallsEnabled: false,
      },
      {
        phoneNumber: '+919811112222',
        fetchImpl: async () => {
          fetched = true;
          throw new Error('network');
        },
      },
    );
    assert.equal(result.networkRequestMade, false);
    assert.equal(fetched, false);
  });
});

test('simulator CLI accepts --url, --token, --token-file and --ws-auth', () => {
  const parsed = parseArgs([
    '--url',
    'wss://example.up.railway.app/ws/voice/smartping',
    '--token',
    'abc123',
  ]);
  assert.equal(parsed.url, 'wss://example.up.railway.app/ws/voice/smartping');
  assert.equal(parsed.token, 'abc123');
  assert.equal(parsed.wsAuth, false);
  const withFile = parseArgs([
    '--url=wss://example.up.railway.app/ws/voice/smartping',
    '--token-file=.railway-stream-secret.local',
    '--ws-auth',
  ]);
  assert.equal(withFile.tokenFile, '.railway-stream-secret.local');
  assert.equal(withFile.wsAuth, true);
});

test('no secret included in stream-only blocked responses', async () => {
  await withServer(
    async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/api/campaigns`);
      const body = await response.json();
      assert.equal(response.status, 404);
      assert.equal(JSON.stringify(body).includes(STREAM_SECRET), false);
      assert.equal(JSON.stringify(body).includes(API_TOKEN), false);
    },
    {
      exposureMode: 'stream-only',
      smartPing: {
        streamAuthMode: 'required',
        streamSharedSecret: STREAM_SECRET,
        apiToken: API_TOKEN,
      },
    },
  );
});
