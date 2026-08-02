import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import WebSocket from 'ws';
import { Repository } from '../src/database.js';
import { MockProvider } from '../src/providers/mock-provider.js';
import { createApp } from '../src/app.js';
import { getConfig, getPublicSettings } from '../src/config.js';
import { StreamSessionManager } from '../src/streaming/session-manager.js';
import { attachVoiceStreaming } from '../src/streaming/websocket-gateway.js';
import { chunkMulawBytes, PacedAudioQueue } from '../src/streaming/audio-queue.js';
import { parseInboundMessage, ProtocolError } from '../src/streaming/protocol.js';
import {
  buildVoicebotCallRequest,
  executeVoicebotCall,
  toRedactedRequestPreview,
} from '../src/streaming/smartping/request-builder.js';
import { containsSecret, redactHeaders } from '../src/streaming/redaction.js';
import { AUDIO, MULAW_SILENCE, STREAM_PATH } from '../src/streaming/constants.js';

const SECRET = 'super-secret-token-value-phase3a';

async function withStreamingServer(run) {
  const repository = new Repository(':memory:');
  const config = getConfig({
    providerName: 'mock',
    webhookSecret: 'test-secret',
    publicBaseUrl: 'http://127.0.0.1',
    exposureMode: 'full',
    smartPing: {
      baseUrl: 'https://smartping.example',
      outboundPath: '/agm/at/streaming/campaign/voicebot/call-customer',
      apiToken: SECRET,
      didNumber: '08000000000',
      streamUrl: `ws://127.0.0.1${STREAM_PATH}`,
      dryRun: true,
      liveCallsEnabled: false,
      storeAudio: false,
      streamAuthMode: 'disabled',
      streamSharedSecret: '',
    },
  });
  config.exposureMode = 'full';
  config.smartPing.streamAuthMode = 'disabled';
  config.smartPing.liveCallsEnabled = false;
  config.smartPing.dryRun = true;
  const provider = new MockProvider();
  const sessionManager = new StreamSessionManager({
    repository,
    config: config.smartPing,
  });
  const server = http.createServer(
    createApp({ repository, provider, config, sessionManager }),
  );
  attachVoiceStreaming({
    server,
    sessionManager,
    config: config.smartPing,
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  const wsUrl = `ws://127.0.0.1:${port}${STREAM_PATH}`;
  try {
    await run({ baseUrl, wsUrl, repository, sessionManager, config });
  } finally {
    sessionManager.closeAll('test_done');
    server.close();
    await once(server, 'close');
    repository.close();
  }
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function waitForMessage(ws, predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('message timeout')), timeoutMs);
    const onMessage = (data) => {
      const message = JSON.parse(String(data));
      if (predicate(message)) {
        clearTimeout(timer);
        ws.off('message', onMessage);
        resolve(message);
      }
    };
    ws.on('message', onMessage);
  });
}

function waitForCollected(collection, predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const match = collection.find(predicate);
      if (match) {
        clearInterval(timer);
        resolve(match);
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(
          new Error(
            `collection timeout; saw=${collection.map((item) => item.event).join(',')}`,
          ),
        );
      }
    }, 20);
  });
}

test('outbound request construction and token redaction', () => {
  const request = buildVoicebotCallRequest({
    baseUrl: 'https://smartping.example/',
    apiToken: SECRET,
    phoneNumber: '+919811112222',
    didNumber: '08000000000',
    streamUrl: 'wss://example.com/ws/voice/smartping',
    customParameters: { app_call_id: 'call-1' },
  });
  assert.equal(
    request.url,
    'https://smartping.example/agm/at/streaming/campaign/voicebot/call-customer',
  );
  assert.equal(request.headers['x-api-token'], SECRET);
  assert.equal(request.body.phone_number, '+919811112222');
  assert.equal(request.body.did_number, '08000000000');
  assert.equal(request.body.url, 'wss://example.com/ws/voice/smartping');
  assert.equal(request.body.channel_vars.custom_parameters.app_call_id, 'call-1');

  const preview = toRedactedRequestPreview(request);
  assert.equal(preview.headers['x-api-token'], '[REDACTED]');
  assert.equal(JSON.stringify(preview).includes(SECRET), false);
  assert.equal(redactHeaders({ 'x-api-token': SECRET })['x-api-token'], '[REDACTED]');
});

test('dry-run prevents network calls', async () => {
  let fetched = false;
  const result = await executeVoicebotCall(
    {
      baseUrl: 'https://smartping.example',
      outboundPath: '/agm/at/streaming/campaign/voicebot/call-customer',
      apiToken: SECRET,
      didNumber: '08000000000',
      streamUrl: 'wss://example.com/ws/voice/smartping',
      dryRun: true,
      liveCallsEnabled: false,
    },
    {
      phoneNumber: '+919811112222',
      fetchImpl: async () => {
        fetched = true;
        throw new Error('should not fetch');
      },
    },
  );
  assert.equal(result.dryRun, true);
  assert.equal(result.networkRequestMade, false);
  assert.equal(fetched, false);
  assert.equal(JSON.stringify(result).includes(SECRET), false);
});

test('protocol validation covers invalid JSON, unknown event, invalid base64, missing streamSid', () => {
  assert.throws(() => parseInboundMessage('{'), (error) => error instanceof ProtocolError);
  assert.throws(
    () => parseInboundMessage(JSON.stringify({ event: 'explode' })),
    (error) => error.code === 'unknown_event',
  );
  assert.throws(
    () =>
      parseInboundMessage(
        JSON.stringify({ event: 'start', start: { callSid: 'CA1' } }),
      ),
    (error) => error.code === 'missing_stream_sid',
  );
  const invalidMedia = parseInboundMessage(
    JSON.stringify({
      event: 'media',
      streamSid: 'MZ1',
      media: { payload: '@@@not-base64@@@' },
    }),
  );
  assert.equal(invalidMedia.validation, 'invalid_base64');
});

test('160-byte chunking and audio queue clearing', async () => {
  const chunks = chunkMulawBytes(Buffer.alloc(350, MULAW_SILENCE));
  assert.equal(chunks.length, 3);
  assert.ok(chunks.every((chunk) => chunk.length === 160));

  const sent = [];
  let tick = null;
  const queue = new PacedAudioQueue({
    sendChunk: (chunk) => sent.push(chunk),
    intervalMs: 1,
    setTimer: (fn) => {
      tick = fn;
      return 1;
    },
    clearTimer: () => {},
  });
  queue.enqueue(Buffer.alloc(320, MULAW_SILENCE));
  assert.equal(queue.pendingChunks, 2);
  tick();
  assert.equal(sent.length, 1);
  const dropped = queue.clear();
  assert.equal(dropped, 1);
  assert.equal(queue.pendingChunks, 0);
  queue.stop();
});

test('connected/start/media/mark/stop, duplicates, commands, cleanup, no secret exposure', async () => {
  await withStreamingServer(async ({ baseUrl, wsUrl, repository, config }) => {
    const ws = await connect(wsUrl);
    const outbound = [];
    ws.on('message', (data) => outbound.push(JSON.parse(String(data))));

    ws.send(JSON.stringify({ event: 'connected', protocol: 'Call', version: '1.0.0' }));
    ws.send(
      JSON.stringify({
        event: 'start',
        sequenceNumber: '1',
        start: {
          streamSid: 'MZSTREAM1',
          callSid: 'CACALL1',
          mediaFormat: {
            encoding: AUDIO.encoding,
            sampleRate: 8000,
            channels: 1,
          },
          customParameters: { app_call_id: 'app-1' },
        },
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 50));
    const stored = repository.getVoiceStream('MZSTREAM1');
    assert.ok(stored);
    assert.equal(stored.call_sid, 'CACALL1');
    assert.equal(stored.custom_parameters.app_call_id, 'app-1');

    for (let index = 0; index < 4; index += 1) {
      ws.send(
        JSON.stringify({
          event: 'media',
          sequenceNumber: String(10 + index),
          streamSid: 'MZSTREAM1',
          media: {
            track: 'inbound',
            chunk: String(index),
            timestamp: String(index * 20),
            payload: Buffer.alloc(160, MULAW_SILENCE).toString('base64'),
          },
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const mediaOut = await waitForCollected(
      outbound,
      (message) => message.event === 'media',
    );
    assert.equal(mediaOut.streamSid, 'MZSTREAM1');
    assert.ok(mediaOut.media.payload);

    const markOut = await waitForCollected(
      outbound,
      (message) => message.event === 'mark',
    );
    ws.send(
      JSON.stringify({
        event: 'mark',
        sequenceNumber: '50',
        streamSid: 'MZSTREAM1',
        mark: { name: markOut.mark.name },
      }),
    );

    // Duplicate sequence should be ignored for processing side-effects.
    ws.send(
      JSON.stringify({
        event: 'media',
        sequenceNumber: '10',
        streamSid: 'MZSTREAM1',
        media: {
          payload: Buffer.alloc(160, MULAW_SILENCE).toString('base64'),
        },
      }),
    );

    const clearRes = await fetch(`${baseUrl}/api/streams/MZSTREAM1/commands`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: 'clear' }),
    });
    assert.equal(clearRes.status, 200);
    await waitForCollected(outbound, (message) => message.event === 'clear');

    const hangupRes = await fetch(`${baseUrl}/api/streams/MZSTREAM1/commands`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: 'hangup' }),
    });
    assert.equal(hangupRes.status, 200);
    await waitForCollected(outbound, (message) => message.event === 'hangupCall');

    const queueRes = await fetch(`${baseUrl}/api/streams/MZSTREAM1/commands`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: 'transfer_queue', queue: 'support' }),
    });
    assert.equal(queueRes.status, 200);
    await waitForCollected(
      outbound,
      (message) => message.event === 'transfer' && message.transfer.type === 'queue',
    );

    const externalRes = await fetch(`${baseUrl}/api/streams/MZSTREAM1/commands`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        command: 'transfer_external',
        phoneNumber: '+919999999999',
      }),
    });
    assert.equal(externalRes.status, 200);
    await waitForCollected(
      outbound,
      (message) =>
        message.event === 'transfer' && message.transfer.type === 'external',
    );

    ws.send(
      JSON.stringify({
        event: 'stop',
        sequenceNumber: '99',
        streamSid: 'MZSTREAM1',
        stop: { callSid: 'CACALL1' },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 80));
    const closed = repository.getVoiceStream('MZSTREAM1');
    assert.equal(closed.state, 'closed');
    assert.ok(closed.closed_at);

    const events = repository.listVoiceStreamEvents('MZSTREAM1');
    assert.ok(events.some((event) => event.event_type === 'start'));
    assert.ok(events.some((event) => event.event_type === 'media'));
    assert.ok(events.every((event) => event.raw_audio_b64 === null));

    const settings = await (await fetch(`${baseUrl}/api/settings`)).json();
    assert.equal(settings.aiProvider, 'deterministic');
    assert.equal(settings.voiceResponseEngine, 'deterministic');
    assert.equal(settings.dryRunEnabled, true);
    assert.equal(settings.liveCallsDisabled, true);
    assert.equal(settings.streamingConfigured, true);
    assert.equal(JSON.stringify(settings).includes(SECRET), false);
    assert.equal(containsSecret(JSON.stringify(settings), [SECRET]), false);

    const preview = await (
      await fetch(`${baseUrl}/api/smartping/outbound/preview`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ phoneNumber: '+919811112222' }),
      })
    ).json();
    assert.equal(preview.dryRun, true);
    assert.equal(preview.networkRequestMade, false);
    assert.equal(JSON.stringify(preview).includes(SECRET), false);

    const publicSettings = getPublicSettings(config, 'mock');
    assert.equal(JSON.stringify(publicSettings).includes(SECRET), false);

    ws.close();
  });
});

test('live calls remain fail-closed when dry-run is disabled', async () => {
  await assert.rejects(
    () =>
      executeVoicebotCall(
        {
          baseUrl: 'https://smartping.example',
          apiToken: SECRET,
          didNumber: '08000000000',
          streamUrl: 'wss://example.com/ws/voice/smartping',
          dryRun: false,
          liveCallsEnabled: true,
        },
        {
          phoneNumber: '+919811112222',
          fetchImpl: async () => {
            throw new Error('network should not be used');
          },
        },
      ),
    /disabled/i,
  );
});
