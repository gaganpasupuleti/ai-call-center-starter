import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import WebSocket from 'ws';
import { getConfig } from '../src/config.js';
import { Repository } from '../src/database.js';
import { StreamSessionManager } from '../src/streaming/session-manager.js';
import { VoicePipeline } from '../src/streaming/ai/pipeline.js';
import { MockTextToSpeech } from '../src/streaming/ai/mock-tts.js';
import { AdmissionsResponseEngine } from '../src/streaming/response/response-engine.js';
import {
  VOICE_LIFECYCLE,
  transitionConversation,
  canAcceptCallerAudio,
  canProcessTranscript,
  completeConversation,
  voiceConversationActive,
} from '../src/streaming/conversation/lifecycle.js';
import { VoiceConversationController } from '../src/streaming/conversation/controller.js';
import { ResponseActionExecutor } from '../src/streaming/actions/response-action-executor.js';
import { clearConversationTimers } from '../src/streaming/conversation/timers.js';
import { STREAM_PATH } from '../src/streaming/constants.js';
import { attachVoiceStreaming } from '../src/streaming/websocket-gateway.js';
import { createApp } from '../src/app.js';
import { createProvider } from '../src/providers/index.js';
import { readFileSync } from 'node:fs';

test('lifecycle transitions and audio gating', () => {
  const session = { state: 'active', metadata: {} };
  transitionConversation(session, VOICE_LIFECYCLE.GREETING_QUEUED);
  transitionConversation(session, VOICE_LIFECYCLE.GREETING_PLAYING);
  assert.equal(canAcceptCallerAudio(session), false);
  transitionConversation(session, VOICE_LIFECYCLE.LISTENING);
  assert.equal(canAcceptCallerAudio(session), true);
  assert.equal(canProcessTranscript(session), true);
  transitionConversation(session, VOICE_LIFECYCLE.SPEAKING);
  assert.equal(canAcceptCallerAudio(session, { ignoreWhileSpeaking: true }), false);
  completeConversation(session, 'completed');
  assert.equal(session.metadata.voiceLifecycle, VOICE_LIFECYCLE.CLOSED);
  assert.equal(
    transitionConversation(session, VOICE_LIFECYCLE.LISTENING).rejected,
    true,
  );
});

test('config validates interaction modes; voice defaults safe', () => {
  const cfg = getConfig({
    voiceConversationEnabled: false,
    voiceInteractionMode: 'dtmf',
  });
  assert.equal(cfg.voiceConversationEnabled, false);
  assert.equal(cfg.voiceInteractionMode, 'dtmf');
  assert.equal(voiceConversationActive(cfg), false);
  assert.throws(() => getConfig({ voiceInteractionMode: 'telepathy' }));
});

test('action executor records follow-up and DNC; transfer simulated when not live', () => {
  const session = { metadata: {}, customParameters: {} };
  const executor = new ResponseActionExecutor({ liveCallsEnabled: false });
  const out = executor.execute(
    [
      { type: 'create_follow_up', channel: 'whatsapp' },
      { type: 'mark_do_not_call' },
      { type: 'transfer_queue', queue: 'admissions' },
    ],
    session,
  );
  assert.equal(out.transferRequested, true);
  assert.equal(out.results.find((r) => r.type === 'transfer_queue').simulated, true);
  assert.equal(session.metadata.doNotCall, true);
  assert.ok(session.metadata.recordedActions.length >= 2);
});

test('greeting drains to listening; audio blocked while speaking', async () => {
  const spoken = [];
  const session = {
    state: 'active',
    streamSid: 'MZtest',
    metadata: {},
    conversationTimers: {},
  };
  const controller = new VoiceConversationController({
    appConfig: {
      voiceConversationEnabled: true,
      voiceInteractionMode: 'voice',
      voiceListenTimeoutMs: 60_000,
      voiceIdleHangupMs: 120_000,
    },
    sttStarter: () => {
      session.metadata.sttStartedByController = true;
    },
    sendMedia: (_s, audio) => spoken.push(audio?.length || 0),
    pipeline: { tts: new MockTextToSpeech() },
  });
  controller.onSessionAttached(session);
  controller.onGreetingQueued(session);
  assert.equal(session.metadata.voiceLifecycle, VOICE_LIFECYCLE.GREETING_PLAYING);
  assert.equal(canAcceptCallerAudio(session), false);
  controller.onBotAudioDrained(session, { kind: 'greeting' });
  assert.equal(session.metadata.voiceLifecycle, VOICE_LIFECYCLE.LISTENING);
  assert.equal(session.metadata.sttStartedByController, true);
  assert.equal(canAcceptCallerAudio(session), true);

  transitionConversation(session, VOICE_LIFECYCLE.SPEAKING);
  assert.equal(canAcceptCallerAudio(session), false);
  clearConversationTimers(session);
});

test('max turns and pending transcript limit', async () => {
  const session = {
    state: 'active',
    streamSid: 'MZt2',
    metadata: { turnTiming: {} },
    conversationTimers: {},
  };
  const controller = new VoiceConversationController({
    appConfig: {
      voiceConversationEnabled: true,
      voiceInteractionMode: 'voice-dtmf',
      voiceMaxTurns: 6,
      voiceListenTimeoutMs: 60_000,
      voiceIdleHangupMs: 120_000,
    },
    pipeline: {
      tts: new MockTextToSpeech(),
    },
    hangup: () => {
      session.hungUp = true;
    },
    closeSession: () => {
      session.state = 'closed';
    },
  });
  controller.onSessionAttached(session);
  session.metadata.conversationTurn = 5;
  transitionConversation(session, VOICE_LIFECYCLE.LISTENING);
  const result = {
    reply: {
      intent: 'SEND_DETAILS',
      replyText: 'Sure',
      language: 'en',
      nextState: 'waiting_for_details_confirmation',
      actions: [{ type: 'create_follow_up' }],
    },
    audio: Buffer.alloc(160, 0xff),
    tts: { provider: 'mock-tts', voice: 'mock', language: 'en' },
    actions: [{ type: 'create_follow_up' }],
  };
  await controller.processTurn(session, result, { hangupAfterClose: false });
  assert.equal(session.metadata.conversationTurn, 6);
  assert.equal(session.metadata.pendingCloseReason, 'max_turns');

  session.metadata.transcriptionActive = true;
  assert.equal(canProcessTranscript(session), false);
  controller.rejectExtraTranscript(session);
  assert.ok(session.metadata.pendingTranscriptRejected >= 1);
  clearConversationTimers(session);
});

test('English and Telugu end-to-end fake conversation via inject', async () => {
  const config = getConfig({
    exposureMode: 'full',
    databasePath: ':memory:',
    voiceConversationEnabled: true,
    voiceInteractionMode: 'voice-dtmf',
    voiceSttProvider: 'mock',
    voiceTtsProvider: 'mock',
    voiceListenTimeoutMs: 60_000,
    voiceIdleHangupMs: 120_000,
    smartPing: {
      dryRun: true,
      liveCallsEnabled: false,
      singleCallEnabled: false,
      playbackMode: 'pipeline',
      streamAuthMode: 'disabled',
    },
  });
  const repository = new Repository(':memory:');
  const pipeline = new VoicePipeline({
    agent: new AdmissionsResponseEngine(),
    tts: new MockTextToSpeech(),
  });
  const sessionManager = new StreamSessionManager({
    repository,
    config: config.smartPing,
    appConfig: config,
    pipeline,
  });
  const server = http.createServer(
    createApp({
      repository,
      provider: createProvider(config),
      config,
      sessionManager,
    }),
  );
  attachVoiceStreaming({
    server,
    sessionManager,
    config: config.smartPing,
    acceptingConnections: { current: true },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  const wsUrl = `ws://127.0.0.1:${port}${STREAM_PATH}`;

  async function runOne(language, text, expectIntent) {
    const streamSid = `MZ${Math.random().toString(16).slice(2)}`;
    const ws = new WebSocket(wsUrl);
    await once(ws, 'open');
    ws.send(JSON.stringify({ event: 'connected', protocol: 'Call', version: '1.0.0' }));
    ws.send(
      JSON.stringify({
        event: 'start',
        sequenceNumber: '1',
        streamSid,
        start: {
          streamSid,
          callSid: `CA${language}`,
          tracks: ['inbound'],
          mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 },
          customParameters: { language },
        },
      }),
    );
    await new Promise((r) => setTimeout(r, 100));
    const inject = await fetch(`http://127.0.0.1:${port}/api/speech/inject-transcript`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ streamSid, text, language }),
    }).then(async (r) => ({ status: r.status, body: await r.json() }));
    assert.equal(inject.status, 200);
    assert.equal(inject.body.intent, expectIntent);
    assert.equal(inject.body.telephoneCalls, 0);
    assert.match(String(inject.body.ttsProvider || 'mock-tts'), /mock/);
    ws.close();
  }

  await runOne('en', 'Please send me the details', 'SEND_DETAILS');
  await runOne('te', 'వివరాలు పంపండి', 'SEND_DETAILS');

  const readiness = await fetch(`http://127.0.0.1:${port}/api/speech/readiness`).then((r) =>
    r.json(),
  );
  assert.equal(readiness.mode, 'mock');
  assert.equal(readiness.ready, true);

  sessionManager.closeAll('test_done');
  await new Promise((r) => setTimeout(r, 50));
  server.close();
  await once(server, 'close');
  repository.close();
});

test('msedge-tts remains removed; no external provider in package.json', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
  assert.equal(pkg.dependencies['msedge-tts'], undefined);
  assert.equal(pkg.dependencies.openai, undefined);
});
