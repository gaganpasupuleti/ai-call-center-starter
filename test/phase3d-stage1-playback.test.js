import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Repository } from '../src/database.js';
import { StreamSessionManager } from '../src/streaming/session-manager.js';
import { chunkMulawBytes, PacedAudioQueue } from '../src/streaming/audio-queue.js';
import { AUDIO, MULAW_SILENCE } from '../src/streaming/constants.js';
import {
  clearWelcomeMulawCache,
  getWelcomeMulaw,
  loadMulawFile,
  FixedAudioError,
} from '../src/streaming/fixed-audio.js';
import {
  executeSingleVoicebotCall,
  executeVoicebotCall,
  SmartPingLiveCallsDisabledError,
  toRedactedRequestPreview,
  buildVoicebotCallRequest,
} from '../src/streaming/smartping/request-builder.js';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SECRET = 'stage1-test-token-not-for-production';
const PHONE = '+15555550199';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function makeSessionManager(configOverrides = {}) {
  const repository = new Repository(':memory:');
  const manager = new StreamSessionManager({
    repository,
    config: {
      storeAudio: false,
      playbackMode: 'fixed-welcome',
      ...configOverrides,
    },
  });
  return { repository, manager };
}

test('start event triggers welcome playback in fixed-welcome mode', async () => {
  clearWelcomeMulawCache();
  const welcome = getWelcomeMulaw();
  const { manager, repository } = makeSessionManager();
  const ws = {
    readyState: 1,
    sent: [],
    send(payload) {
      this.sent.push(JSON.parse(payload));
    },
  };
  const session = manager.attachSocket(ws);
  const result = await manager.handleNormalizedEvent(session, {
    event: 'start',
    sequenceNumber: '1',
    streamSid: 'MZwelcome1',
    callSid: 'CAwelcome1',
    mediaFormat: {
      encoding: AUDIO.encoding,
      sampleRate: AUDIO.sampleRate,
      channels: 1,
    },
    customParameters: {},
    tracks: ['inbound'],
  });

  assert.equal(result.ok, true);
  assert.equal(result.playback.mode, 'fixed-welcome');
  assert.ok(result.playback.enqueuedChunks > 0);
  assert.equal(
    result.playback.enqueuedChunks,
    chunkMulawBytes(welcome.bytes).length,
  );
  assert.equal(session.metadata.playbackMode, 'fixed-welcome');
  assert.ok(session.queue.pendingChunks > 0);

  // Bypass STT/TTS on inbound media.
  const mediaResult = await manager.handleNormalizedEvent(session, {
    event: 'media',
    sequenceNumber: '2',
    streamSid: 'MZwelcome1',
    payloadSize: 160,
    payload: Buffer.alloc(160, MULAW_SILENCE),
    validation: 'ok',
  });
  assert.equal(mediaResult.pipelineSkipped, true);
  assert.equal(mediaResult.playbackMode, 'fixed-welcome');

  const serialized = JSON.stringify({
    result,
    mediaResult,
    stats: session.stats,
  });
  assert.equal(serialized.includes(SECRET), false);
  assert.equal(serialized.includes(PHONE), false);
  assert.equal(serialized.includes('payload'), false);

  manager.closeAll('test_done');
  repository.close();
});

test('mulaw data is chunked and paced correctly', () => {
  const bytes = Buffer.alloc(400, 0x7f);
  const chunks = chunkMulawBytes(bytes);
  assert.equal(chunks.length, 3);
  assert.ok(chunks.every((chunk) => chunk.length === 160));

  const sent = [];
  let tick = null;
  const queue = new PacedAudioQueue({
    sendChunk: (chunk) => sent.push(chunk),
    intervalMs: 20,
    setTimer: (fn) => {
      tick = fn;
      return 1;
    },
    clearTimer: () => {},
  });
  const enqueued = queue.enqueue(bytes);
  assert.equal(enqueued, 3);
  assert.equal(queue.pendingChunks, 3);
  tick();
  tick();
  assert.equal(sent.length, 2);
  assert.equal(queue.pendingChunks, 1);
  queue.stop();
});

test('missing welcome audio fails safely', async () => {
  clearWelcomeMulawCache();
  assert.throws(
    () => loadMulawFile(path.join(tmpdir(), 'missing-welcome-stage1.ulaw')),
    (error) => error instanceof FixedAudioError && error.code === 'welcome_audio_missing',
  );

  const { manager, repository } = makeSessionManager({
    welcomeAudioPath: path.join(tmpdir(), 'missing-welcome-stage1.ulaw'),
  });
  const ws = {
    readyState: 1,
    sent: [],
    send(payload) {
      this.sent.push(JSON.parse(payload));
    },
  };
  const session = manager.attachSocket(ws);
  const result = await manager.handleNormalizedEvent(session, {
    event: 'start',
    sequenceNumber: '1',
    streamSid: 'MZmissing1',
    callSid: 'CAmissing1',
    mediaFormat: null,
    customParameters: {},
    tracks: [],
  });
  assert.equal(result.ok, true);
  assert.equal(result.playback.mode, 'fixed-welcome');
  assert.equal(result.playback.enqueuedChunks, 0);
  assert.equal(result.playback.error, 'welcome_audio_missing');
  assert.equal(session.queue.pendingChunks, 0);

  manager.closeAll('test_done');
  repository.close();
});

test('live call gates fail closed for campaign and single-call paths', async () => {
  let fetched = false;
  const fetchImpl = async () => {
    fetched = true;
    return { status: 200, text: async () => '{}' };
  };

  await assert.rejects(
    () =>
      executeVoicebotCall(
        {
          baseUrl: 'https://smartping.example',
          outboundPath: '/agm/at/streaming/campaign/voicebot/call-customer',
          apiToken: SECRET,
          didNumber: '08000000000',
          streamUrl: 'wss://example.com/ws/voice/smartping',
          dryRun: false,
          liveCallsEnabled: true,
          singleCallEnabled: true,
        },
        { phoneNumber: PHONE, fetchImpl },
      ),
    (error) => error instanceof SmartPingLiveCallsDisabledError,
  );
  assert.equal(fetched, false);

  await assert.rejects(
    () =>
      executeSingleVoicebotCall(
        {
          baseUrl: 'https://smartping.example',
          outboundPath: '/agm/at/streaming/campaign/voicebot/call-customer',
          apiToken: SECRET,
          didNumber: '08000000000',
          streamUrl: 'wss://example.com/ws/voice/smartping',
          dryRun: false,
          liveCallsEnabled: true,
          singleCallEnabled: false,
        },
        { phoneNumber: PHONE, confirm: true, fetchImpl },
      ),
    (error) => error instanceof SmartPingLiveCallsDisabledError,
  );
  assert.equal(fetched, false);

  await assert.rejects(
    () =>
      executeSingleVoicebotCall(
        {
          baseUrl: 'https://smartping.example',
          outboundPath: '/agm/at/streaming/campaign/voicebot/call-customer',
          apiToken: SECRET,
          didNumber: '08000000000',
          streamUrl: 'wss://example.com/ws/voice/smartping',
          dryRun: false,
          liveCallsEnabled: false,
          singleCallEnabled: true,
        },
        { phoneNumber: PHONE, confirm: true, fetchImpl },
      ),
    (error) => error instanceof SmartPingLiveCallsDisabledError,
  );
  assert.equal(fetched, false);
});

test('no call without --confirm', async () => {
  let fetched = false;
  await assert.rejects(
    () =>
      executeSingleVoicebotCall(
        {
          baseUrl: 'https://smartping.example',
          outboundPath: '/agm/at/streaming/campaign/voicebot/call-customer',
          apiToken: SECRET,
          didNumber: '08000000000',
          streamUrl: 'wss://example.com/ws/voice/smartping',
          dryRun: false,
          liveCallsEnabled: true,
          singleCallEnabled: true,
        },
        {
          phoneNumber: PHONE,
          confirm: false,
          fetchImpl: async () => {
            fetched = true;
            return { status: 200, text: async () => '{}' };
          },
        },
      ),
    (error) =>
      error instanceof SmartPingLiveCallsDisabledError &&
      /confirm/i.test(error.message),
  );
  assert.equal(fetched, false);

  const cli = spawnSync(
    process.execPath,
    [path.join(root, 'scripts', 'place-test-call.mjs')],
    {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        SMARTPING_BASE_URL: 'https://smartping.example',
        SMARTPING_API_TOKEN: SECRET,
        SMARTPING_DID_NUMBER: '08000000000',
        SMARTPING_TEST_PHONE_NUMBER: PHONE,
        SMARTPING_DRY_RUN: 'true',
        SMARTPING_LIVE_CALLS_ENABLED: 'false',
        SMARTPING_SINGLE_CALL_ENABLED: 'false',
      },
    },
  );
  assert.notEqual(cli.status, 0);
  assert.equal(cli.stdout.includes(SECRET), false);
  assert.equal(cli.stderr.includes(SECRET), false);
  assert.equal(cli.stdout.includes(PHONE), false);
  assert.equal(cli.stderr.includes(PHONE), false);
});

test('redacted preview never includes phone or token values', () => {
  const request = buildVoicebotCallRequest({
    baseUrl: 'https://smartping.example',
    outboundPath: '/agm/at/streaming/campaign/voicebot/call-customer',
    apiToken: SECRET,
    phoneNumber: PHONE,
    didNumber: '08000000000',
    streamUrl: 'wss://example.com/ws/voice/smartping',
    customParameters: { app_call_id: 'x' },
  });
  const preview = toRedactedRequestPreview(request);
  const serialized = JSON.stringify(preview);
  assert.equal(serialized.includes(SECRET), false);
  assert.equal(serialized.includes(PHONE), false);
  assert.equal(preview.body.phone_number, '[REDACTED]');
  assert.equal(preview.body.did_number, '[REDACTED]');
});

test('webhook status remains stored and duplicates acknowledged', () => {
  const repository = new Repository(':memory:');
  const first = repository.recordSmartPingCallStatusEvent({
    eventKey: 'stage1-evt-1',
    callRef: 'CAsynth',
    status: 'completed',
    phoneHash: 'abc123hash',
    metadata: { fieldKeys: ['event_id', 'status'] },
  });
  const second = repository.recordSmartPingCallStatusEvent({
    eventKey: 'stage1-evt-1',
    callRef: 'CAsynth',
    status: 'completed',
    phoneHash: 'abc123hash',
    metadata: { fieldKeys: ['event_id', 'status'] },
  });
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(first.eventKey, 'stage1-evt-1');
  const serialized = JSON.stringify({ first, second });
  assert.equal(serialized.includes(PHONE), false);
  assert.equal(serialized.includes(SECRET), false);
  repository.close();
});

test('empty welcome file fails safely', () => {
  clearWelcomeMulawCache();
  const dir = mkdtempSync(path.join(tmpdir(), 'welcome-empty-'));
  const filePath = path.join(dir, 'empty.ulaw');
  writeFileSync(filePath, Buffer.alloc(0));
  assert.throws(
    () => loadMulawFile(filePath),
    (error) => error instanceof FixedAudioError && error.code === 'welcome_audio_empty',
  );
  rmSync(dir, { recursive: true, force: true });
});

test('duplicate start events play fixed welcome only once', async () => {
  clearWelcomeMulawCache();
  const { manager, repository } = makeSessionManager();
  const ws = {
    readyState: 1,
    sent: [],
    send(payload) {
      this.sent.push(JSON.parse(payload));
    },
  };
  const session = manager.attachSocket(ws);
  const startEvent = {
    event: 'start',
    sequenceNumber: '1',
    streamSid: 'MZdup1',
    callSid: 'CAdup1',
    mediaFormat: {
      encoding: AUDIO.encoding,
      sampleRate: AUDIO.sampleRate,
      channels: 1,
    },
    customParameters: {},
    tracks: ['inbound'],
  };
  const first = await manager.handleNormalizedEvent(session, startEvent);
  const second = await manager.handleNormalizedEvent(session, {
    ...startEvent,
    sequenceNumber: '2',
  });
  assert.equal(first.playback.enqueuedChunks > 0, true);
  assert.equal(second.duplicateStart, true);
  assert.equal(second.playback.skippedDuplicate, true);
  assert.equal(second.playback.enqueuedChunks, 0);
  assert.equal(session.metadata.welcomePlayed, true);
  manager.closeAll('test_done');
  repository.close();
});

test('welcome audio is non-empty speech-length mulaw', () => {
  clearWelcomeMulawCache();
  const welcome = getWelcomeMulaw();
  assert.ok(welcome.byteLength > 1000);
  assert.ok(welcome.durationSeconds > 1);
  assert.ok(welcome.energyRatio > 0.02);
  assert.equal(welcome.sampleRate, 8000);
  assert.equal(welcome.channels, 1);
});
