import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { getConfig } from '../src/config.js';
import { Repository } from '../src/database.js';
import { createProvider } from '../src/providers/index.js';
import { createApp } from '../src/app.js';
import { StreamSessionManager } from '../src/streaming/session-manager.js';
import { CallStationTracker } from '../src/streaming/call-station-tracker.js';
import {
  calculateDurationSeconds,
  derivePickupState,
  maskPhone,
  normalizeStationStatus,
  sanitizeCallRef,
  stripSensitive,
  toStationCallDto,
} from '../src/streaming/call-station.js';
import { AUDIO } from '../src/streaming/constants.js';

const SECRET = 'call-station-secret-token-never-leak';
const PHONE = '+15555550123';

function makeConfig() {
  const config = getConfig({
    exposureMode: 'full',
    databasePath: ':memory:',
    smartPing: {
      apiToken: SECRET,
      didNumber: '08001234567',
      dryRun: true,
      liveCallsEnabled: false,
      singleCallEnabled: false,
      playbackMode: 'fixed-welcome',
      streamUrl: 'wss://example.invalid/ws/voice/smartping',
    },
  });
  config.exposureMode = 'full';
  return config;
}

async function withServer(run) {
  const config = makeConfig();
  const repository = new Repository(':memory:');
  const provider = createProvider(config);
  const callStation = new CallStationTracker({
    repository,
    config: config.smartPing,
  });
  const sessionManager = new StreamSessionManager({
    repository,
    config: config.smartPing,
    callStation,
  });
  callStation.setSessionManager(sessionManager);
  const server = http.createServer(
    createApp({ repository, provider, config, sessionManager, callStation }),
  );
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  try {
    await run({ base, repository, callStation, sessionManager, config });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    repository.close();
  }
}

async function getJson(base, path) {
  const response = await fetch(`${base}${path}`);
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

test('phone and DID masking keep only last four digits', () => {
  assert.equal(maskPhone(PHONE), '••••0123');
  assert.equal(maskPhone('08001234567'), '••••4567');
  assert.equal(maskPhone('12'), '••••');
  assert.equal(maskPhone(null), null);
});

test('sensitive fields are removed from nested objects', () => {
  const cleaned = stripSensitive({
    ok: true,
    authorization: 'Bearer x',
    token: SECRET,
    phone: PHONE,
    did: '0800',
    headers: { authorization: 'x' },
    payload: { audio: 'abc' },
    ip: '1.2.3.4',
    nested: { api_token: SECRET, status: 'ok' },
  });
  const serialized = JSON.stringify(cleaned);
  assert.equal(serialized.includes(SECRET), false);
  assert.equal(serialized.includes(PHONE), false);
  assert.equal(serialized.includes('1.2.3.4'), false);
  assert.equal(cleaned.nested.status, 'ok');
  assert.equal(cleaned.authorization, undefined);
});

test('duration calculation and status normalization', () => {
  assert.equal(
    calculateDurationSeconds('2026-07-29T10:00:00.000Z', '2026-07-29T10:00:06.500Z'),
    6.5,
  );
  assert.equal(calculateDurationSeconds(null, '2026-07-29T10:00:00.000Z'), null);
  assert.equal(normalizeStationStatus('streaming'), 'Streaming');
  assert.equal(normalizeStationStatus('no_answer'), 'No answer');
  assert.equal(normalizeStationStatus('nope'), 'Unknown');
  assert.equal(sanitizeCallRef('CA1234567890ABCDEF'), 'CA1234…CDEF');
});

test('pickup state reflects answered vs missed calls', () => {
  assert.equal(
    derivePickupState({ status: 'answered', answered_at: '2026-07-29T10:00:00.000Z' })
      .code,
    'picked_up',
  );
  assert.equal(derivePickupState({ status: 'no_answer' }).code, 'not_picked_up');
  assert.equal(derivePickupState({ status: 'busy' }).label, 'Not picked up');
  assert.equal(derivePickupState({ status: 'ringing' }).code, 'ringing');
  const dto = toStationCallDto({
    id: 'x',
    public_ref: 'TC-1',
    status: 'completed',
    answered_at: '2026-07-29T10:00:00.000Z',
    timeline: [],
  });
  assert.equal(dto.pickupCode, 'picked_up');
  assert.equal(dto.pickedUp, true);
});

test('empty call history summary and list', async () => {
  await withServer(async ({ base }) => {
    const summary = await getJson(base, '/api/call-station/summary');
    assert.equal(summary.response.status, 200);
    assert.equal(summary.body.totalTestCalls, 0);
    assert.equal(summary.body.activeWebSocketSessions, 0);

    const calls = await getJson(base, '/api/call-station/calls');
    assert.equal(calls.response.status, 200);
    assert.deepEqual(calls.body.items, []);
  });
});

test('call details timeline ordering and duplicate-event handling', async () => {
  await withServer(async ({ callStation, sessionManager, repository }) => {
    const ws = {
      readyState: 1,
      sent: [],
      send(payload) {
        this.sent.push(JSON.parse(payload));
      },
    };
    const session = sessionManager.attachSocket(ws);
    callStation.onSessionOpened(session);
    await sessionManager.handleNormalizedEvent(session, {
      event: 'connected',
      protocol: 'Call',
      version: '1.0.0',
    });
    await sessionManager.handleNormalizedEvent(session, {
      event: 'start',
      sequenceNumber: '1',
      streamSid: 'MZstation1',
      callSid: 'CAstation1',
      mediaFormat: {
        encoding: AUDIO.encoding,
        sampleRate: AUDIO.sampleRate,
        channels: 1,
      },
      customParameters: {},
      tracks: ['inbound'],
    });
    await sessionManager.handleNormalizedEvent(session, {
      event: 'start',
      sequenceNumber: '2',
      streamSid: 'MZstation1',
      callSid: 'CAstation1',
      mediaFormat: {
        encoding: AUDIO.encoding,
        sampleRate: AUDIO.sampleRate,
        channels: 1,
      },
      customParameters: {},
      tracks: ['inbound'],
    });
    await sessionManager.handleNormalizedEvent(session, {
      event: 'stop',
      sequenceNumber: '3',
      streamSid: 'MZstation1',
      callSid: 'CAstation1',
    });

    const dto = callStation.getCall(`TC-${session.id.replace(/-/g, '').slice(0, 10)}`);
    assert.ok(dto);
    const events = dto.timeline.map((item) => item.event);
    assert.ok(events.includes('websocket_connected'));
    assert.ok(events.includes('start'));
    assert.ok(events.includes('fixed_audio_queued'));
    assert.ok(events.includes('stop'));
    assert.ok(events.includes('websocket_closed'));
    assert.ok(events.includes('final_status_stored'));
    assert.equal(events.filter((e) => e === 'fixed_audio_queued').length, 1);
    assert.equal(dto.keypadOption, 'Not supported');

    const serialized = JSON.stringify(dto);
    assert.equal(serialized.includes(SECRET), false);
    assert.equal(serialized.includes(PHONE), false);
    assert.equal(serialized.includes('payload'), false);

    // Ensure repository timeline is chronological by insertion order.
    const row = repository.listStreamTestCalls({})[0];
    const stamps = row.timeline.map((item) => Date.parse(item.ts));
    for (let i = 1; i < stamps.length; i += 1) {
      assert.ok(stamps[i] >= stamps[i - 1]);
    }
  });
});

test('API responses never include secrets or raw phones', async () => {
  const previousPhone = process.env.SMARTPING_TEST_PHONE_NUMBER;
  process.env.SMARTPING_TEST_PHONE_NUMBER = PHONE;
  try {
    await withServer(async ({ base, callStation }) => {
      callStation.recordSingleCallRequest({
        destinationMasked: maskPhone(PHONE),
        dryRun: true,
      });
      const paths = [
        '/api/call-station/summary',
        '/api/call-station/calls',
        '/api/call-station/health',
      ];
      for (const path of paths) {
        const { response, body } = await getJson(base, path);
        assert.equal(response.status, 200);
        const serialized = JSON.stringify(body);
        assert.equal(serialized.includes(SECRET), false);
        assert.equal(serialized.includes(PHONE), false);
        assert.equal(serialized.includes('+15555550123'), false);
      }

      const health = await getJson(base, '/api/call-station/health');
      assert.equal(health.body.liveCallActionAvailable, false);
      assert.match(health.body.liveCallMessage, /server-side approval/i);
      assert.equal(health.body.destinationMasked, '••••0123');
    });
  } finally {
    if (previousPhone === undefined) delete process.env.SMARTPING_TEST_PHONE_NUMBER;
    else process.env.SMARTPING_TEST_PHONE_NUMBER = previousPhone;
  }
});

test('failed API state returns not found for unknown call', async () => {
  await withServer(async ({ base }) => {
    const { response, body } = await getJson(
      base,
      '/api/call-station/calls/does-not-exist',
    );
    assert.equal(response.status, 404);
    assert.equal(body.error, 'Call not found');
  });
});

test('DTO mapping keeps sanitized values only', () => {
  const dto = toStationCallDto({
    id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    public_ref: 'TC-aaaaaaaaaa',
    provider_call_id: 'CA1234567890ABCDEF',
    destination_masked: '••••0123',
    did_masked: '••••4567',
    status: 'completed',
    answered_at: '2026-07-29T10:00:00.000Z',
    ended_at: '2026-07-29T10:00:08.000Z',
    duration_seconds: null,
    ws_accepted: 1,
    ws_opened_at: '2026-07-29T10:00:00.000Z',
    ws_closed_at: '2026-07-29T10:00:08.000Z',
    ws_close_code: 1000,
    protocol_events: { start: 1, media: 3, stop: 1 },
    audio_status: 'completed',
    webhook_received_at: '2026-07-29T10:00:09.000Z',
    webhook_duplicate: 0,
    webhook_status: 'completed',
    failure_category: null,
    timeline: [{ ts: '2026-07-29T10:00:00.000Z', event: 'start', detail: null }],
    authorization: SECRET,
    phone: PHONE,
  });
  assert.equal(dto.durationSeconds, 8);
  assert.equal(dto.websocket.result, 'closed');
  assert.equal(dto.webhook.result, 'received');
  assert.equal(dto.authorization, undefined);
  assert.equal(dto.phone, undefined);
  const serialized = JSON.stringify(dto);
  assert.equal(serialized.includes(SECRET), false);
  assert.equal(serialized.includes(PHONE), false);
});
