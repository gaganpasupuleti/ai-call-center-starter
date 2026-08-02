import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { StreamingSttClient } from '../src/streaming/stt/streaming-stt-client.js';
import { StreamingSttManager } from '../src/streaming/stt/streaming-stt-manager.js';
import { buildStartMessage, parseServerMessage } from '../src/streaming/stt/protocol.js';
import { VoicePipeline } from '../src/streaming/ai/pipeline.js';
import { AdmissionsResponseEngine } from '../src/streaming/response/response-engine.js';
import { MockSpeechToText } from '../src/streaming/ai/mock-stt.js';
import { getConfig } from '../src/config.js';
import { StreamSessionManager } from '../src/streaming/session-manager.js';
import { Repository } from '../src/database.js';
import { STREAM_STATES } from '../src/streaming/constants.js';

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.readyState = 0;
    this.sent = [];
    this.binary = [];
  }

  send(data) {
    if (Buffer.isBuffer(data)) this.binary.push(data);
    else this.sent.push(String(data));
  }

  close() {
    this.readyState = 3;
    this.emit('close');
  }

  terminate() {
    this.close();
  }
}

function fakeWebSocketFactory(handler) {
  return class FakeWebSocket extends FakeSocket {
    constructor(url, opts = {}) {
      super();
      this.url = url;
      this.opts = opts;
      queueMicrotask(() => {
        this.readyState = 1;
        this.emit('open');
        handler?.(this);
      });
    }
  };
}

function readyMessage(streamSid = 'MZ1') {
  return Buffer.from(
    JSON.stringify({
      type: 'ready',
      streamSid,
      sampleRate: 8000,
      vadWindowSamples: 256,
    }),
  );
}

test('1 STT client sends valid start message', async () => {
  let socket;
  const WS = fakeWebSocketFactory((ws) => {
    socket = ws;
    queueMicrotask(() => ws.emit('message', readyMessage(), false));
  });
  const client = new StreamingSttClient({
    url: 'ws://fake/v1/stream',
    streamSid: 'MZ1',
    language: 'en',
    WebSocketImpl: WS,
  });
  await client.connect();
  const start = JSON.parse(socket.sent[0]);
  assert.equal(start.type, 'start');
  assert.equal(start.streamSid, 'MZ1');
  assert.equal(start.encoding, 'mulaw');
  assert.equal(start.sampleRate, 8000);
  await client.stop();
});

test('2 binary mulaw frames are forwarded', async () => {
  let socket;
  const WS = fakeWebSocketFactory((ws) => {
    socket = ws;
    queueMicrotask(() => ws.emit('message', readyMessage(), false));
  });
  const client = new StreamingSttClient({
    url: 'ws://fake',
    streamSid: 'MZ1',
    WebSocketImpl: WS,
  });
  await client.connect();
  const frame = Buffer.alloc(160, 0xff);
  client.pushAudio(frame);
  assert.equal(socket.binary.length, 1);
  assert.ok(socket.binary[0].equals(frame));
  await client.stop();
});

test('3 service transcript is parsed', () => {
  const parsed = parseServerMessage({
    type: 'transcript',
    streamSid: 'MZ1',
    text: 'send me the course details',
    language: 'en',
    languageProbability: 0.91,
    isFinal: true,
    provider: 'faster-whisper',
  });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.event.text, 'send me the course details');
});

test('4 malformed transcript rejected safely', () => {
  const parsed = parseServerMessage({
    type: 'transcript',
    streamSid: 'MZ1',
    text: 123,
    isFinal: true,
  });
  assert.equal(parsed.ok, false);
});

test('5-8 manager isolates clients and closes them', async () => {
  const WS = fakeWebSocketFactory((ws) => {
    queueMicrotask(() => ws.emit('message', readyMessage('x'), false));
  });
  const manager = new StreamingSttManager({
    url: 'ws://fake',
    WebSocketImpl: WS,
  });
  await manager.startSession({ streamSid: 'A' });
  await manager.startSession({ streamSid: 'B' });
  assert.equal(manager.size(), 2);
  assert.notEqual(manager.get('A'), manager.get('B'));
  await manager.stopSession('A');
  assert.equal(manager.size(), 1);
  await manager.closeAll();
  assert.equal(manager.size(), 0);
});

test('9 connection timeout is handled', async () => {
  const WS = class extends FakeSocket {
    constructor() {
      super();
    }
  };
  const client = new StreamingSttClient({
    url: 'ws://fake',
    streamSid: 'MZ1',
    connectTimeoutMs: 30,
    WebSocketImpl: WS,
  });
  await assert.rejects(() => client.connect(), /timeout|STT/i);
});

test('10 pending audio buffer is bounded', async () => {
  const errors = [];
  const WS = fakeWebSocketFactory(() => {});
  const client = new StreamingSttClient({
    url: 'ws://fake',
    streamSid: 'MZ1',
    maxPendingAudioBytes: 300,
    connectTimeoutMs: 200,
    WebSocketImpl: WS,
    onError: (e) => errors.push(e.code),
  });
  const p = client.connect().catch(() => {});
  client.pushAudio(Buffer.alloc(160, 1));
  client.pushAudio(Buffer.alloc(160, 2));
  client.pushAudio(Buffer.alloc(160, 3));
  assert.ok(client.pendingBytes <= 300);
  assert.ok(errors.includes('stt_audio_overflow'));
  await p;
  await client.stop();
});

test('11 VOICE_STT_PROVIDER=mock preserves old behaviour', () => {
  const cfg = getConfig({ voiceSttProvider: 'mock' });
  assert.equal(cfg.voiceSttProvider, 'mock');
  const unknown = getConfig({ voiceSttProvider: 'openai' });
  assert.equal(unknown.voiceSttProvider, 'mock');
});

test('12 faster-whisper-streaming skips mock STT on media', async () => {
  const mediaCalls = [];
  const pipeline = new VoicePipeline({ agent: new AdmissionsResponseEngine() });
  const repo = new Repository(':memory:');
  const manager = new StreamSessionManager({
    repository: repo,
    config: { playbackMode: 'pipeline' },
    pipeline,
    appConfig: {
      voiceSttProvider: 'faster-whisper-streaming',
      stt: { streamUrl: 'ws://fake', defaultLanguage: 'en' },
    },
    sttManager: {
      startSession: async () => ({}),
      pushAudio: (sid, audio) => mediaCalls.push({ sid, len: audio.length }),
      stopSession: async () => {},
      closeAll: async () => {},
    },
  });
  const session = manager.attachSocket({ readyState: 3 });
  session.streamSid = 'MZSTREAM';
  session.callSid = 'CA1';
  session.state = STREAM_STATES.active;
  session.metadata = {};
  manager.sessions.set('MZSTREAM', session);
  session.queue = {
    enqueue: () => 1,
    pendingChunks: 0,
    stop() {},
    clear() {
      return 0;
    },
  };

  const mediaResult = await manager.handleNormalizedEvent(session, {
    event: 'media',
    validation: 'ok',
    payload: Buffer.alloc(160, 0xff),
    payloadSize: 160,
  });
  assert.equal(mediaResult.streamingStt, true);
  assert.equal(mediaCalls.length, 1);
  repo.close();
});

test('13 handleTranscript invoked for finalized streaming text', async () => {
  let transcriptHandler = null;
  const enqueued = [];
  const pipeline = new VoicePipeline({ agent: new AdmissionsResponseEngine() });
  const repo = new Repository(':memory:');
  const manager = new StreamSessionManager({
    repository: repo,
    config: { playbackMode: 'pipeline' },
    pipeline,
    appConfig: {
      voiceSttProvider: 'faster-whisper-streaming',
      stt: { defaultLanguage: 'en' },
    },
    sttManager: {
      startSession: async ({ onTranscript }) => {
        transcriptHandler = onTranscript;
        return {};
      },
      pushAudio() {},
      stopSession: async () => {},
      closeAll: async () => {},
    },
  });

  const session = manager.attachSocket({ readyState: 1, send() {} });
  session.metadata = {};
  session.queue = {
    enqueue(bytes) {
      enqueued.push(bytes?.length || 0);
      return 1;
    },
    pendingChunks: 0,
    stop() {},
    clear() {
      return 0;
    },
  };

  // Trigger STT start path via start event (pipeline playback mode)
  await manager.handleNormalizedEvent(session, {
    event: 'start',
    streamSid: 'MZCB',
    callSid: 'CA',
    mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000 },
    customParameters: {},
  });

  // Wait for async startSession
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(transcriptHandler);

  await transcriptHandler({
    type: 'transcript',
    text: 'send me the details',
    language: 'en',
    isFinal: true,
    provider: 'faster-whisper',
  });
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(session.metadata.lastIntent, 'SEND_DETAILS');
  assert.ok(enqueued.length >= 1);
  repo.close();
});

test('14 English transcript to response engine', async () => {
  const pipeline = new VoicePipeline({ agent: new AdmissionsResponseEngine() });
  const result = await pipeline.handleTranscript({
    text: 'book a demo',
    isFinal: true,
    language: 'en',
  });
  assert.equal(result.reply.intent, 'BOOK_DEMO');
});

test('15 Telugu transcript to response engine', async () => {
  const pipeline = new VoicePipeline({ agent: new AdmissionsResponseEngine() });
  const result = await pipeline.handleTranscript({
    text: 'వివరాలు పంపండి',
    isFinal: true,
    language: 'te',
  });
  assert.equal(result.reply.intent, 'SEND_DETAILS');
  assert.equal(result.reply.language, 'te');
});

test('16-17 mock TTS audio and transfer_queue remain functional', async () => {
  const pipeline = new VoicePipeline({ agent: new AdmissionsResponseEngine() });
  const human = await pipeline.handleTranscript({
    text: 'transfer the call',
    isFinal: true,
  });
  assert.ok(human.audio?.length > 0);
  assert.deepEqual(human.actions, [{ type: 'transfer_queue', queue: 'admissions' }]);
});

test('18 transcript after call closure is ignored', async () => {
  let transcriptHandler = null;
  const pipeline = new VoicePipeline({ agent: new AdmissionsResponseEngine() });
  const repo = new Repository(':memory:');
  const manager = new StreamSessionManager({
    repository: repo,
    config: { playbackMode: 'pipeline' },
    pipeline,
    appConfig: {
      voiceSttProvider: 'faster-whisper-streaming',
      stt: { defaultLanguage: 'en' },
    },
    sttManager: {
      startSession: async ({ onTranscript }) => {
        transcriptHandler = onTranscript;
        return {};
      },
      pushAudio() {},
      stopSession: async () => {},
      closeAll: async () => {},
    },
  });
  const session = manager.attachSocket({ readyState: 1, send() {} });
  session.metadata = {};
  session.queue = {
    enqueue: () => 1,
    pendingChunks: 0,
    stop() {},
    clear() {
      return 0;
    },
  };
  await manager.handleNormalizedEvent(session, {
    event: 'start',
    streamSid: 'MZ3',
    callSid: 'CA3',
    mediaFormat: {},
    customParameters: {},
  });
  await new Promise((r) => setTimeout(r, 20));
  session.state = STREAM_STATES.closed;
  await transcriptHandler({ text: 'hello', isFinal: true });
  assert.equal(session.metadata.lastTranscript, undefined);
  repo.close();
});

test('buildStartMessage helper', () => {
  const msg = buildStartMessage({ streamSid: 'MZ', language: 'te' });
  assert.equal(msg.language, 'te');
  assert.equal(msg.channels, 1);
});

test('handleInboundAudio still uses mock STT DI', async () => {
  const pipeline = new VoicePipeline({
    stt: new MockSpeechToText(),
    agent: new AdmissionsResponseEngine(),
  });
  const result = await pipeline.handleInboundAudio(Buffer.alloc(320, 1), {
    metadata: {},
  });
  assert.ok(result.transcript?.text);
  assert.ok(result.reply?.replyText);
});
