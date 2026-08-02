import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeText } from '../src/streaming/response/normalize-text.js';
import { AdmissionsResponseEngine } from '../src/streaming/response/response-engine.js';
import {
  getConversationState,
  setConversationState,
  getUnknownCount,
  CONVERSATION_STATES,
} from '../src/streaming/response/conversation-state.js';
import { VoicePipeline, createConversationAgent } from '../src/streaming/ai/pipeline.js';
import { MockSpeechToText } from '../src/streaming/ai/mock-stt.js';
import { MockConversationAgent } from '../src/streaming/ai/mock-agent.js';
import { MockTextToSpeech } from '../src/streaming/ai/mock-tts.js';
import { getConfig, getPublicSettings } from '../src/config.js';

function session() {
  return { metadata: {} };
}

async function decide(text, sess = session()) {
  const engine = new AdmissionsResponseEngine();
  return { decision: await engine.respond({ text, session: sess }), session: sess };
}

test('normalizeText lowercases English and strips punctuation', () => {
  assert.equal(
    normalizeText('  Send me the DETAILS, please!  '),
    'send me the details please',
  );
});

test('normalizeText preserves Telugu and handles null', () => {
  assert.equal(normalizeText(null), '');
  assert.equal(normalizeText(undefined), '');
  const te = normalizeText('  వివరాలు పంపండి!  ');
  assert.match(te, /వివరాలు/);
  assert.match(te, /పంపండి/);
});

test('1 English SEND_DETAILS', async () => {
  const { decision } = await decide('send me the details');
  assert.equal(decision.intent, 'SEND_DETAILS');
  assert.ok(decision.intentConfidence >= 0.7);
  assert.match(decision.replyText, /WhatsApp/i);
  assert.deepEqual(decision.actions, [
    { type: 'create_follow_up', channel: 'whatsapp' },
  ]);
  assert.equal(decision.provider, 'deterministic-response-engine');
  assert.equal(decision.language, 'en');
});

test('2 English BOOK_DEMO', async () => {
  const { decision } = await decide('book a demo');
  assert.equal(decision.intent, 'BOOK_DEMO');
  assert.match(decision.replyText, /day|demo/i);
  assert.equal(decision.nextState, 'waiting_for_demo_date');
});

test('3 English CALLBACK', async () => {
  const { decision } = await decide('call me later');
  assert.equal(decision.intent, 'CALLBACK');
  assert.deepEqual(decision.actions, [{ type: 'collect_callback_time' }]);
  assert.equal(decision.nextState, 'waiting_for_callback_time');
});

test('4 English DO_NOT_CALL', async () => {
  const { decision } = await decide('do not call me again');
  assert.equal(decision.intent, 'DO_NOT_CALL');
  assert.deepEqual(decision.actions, [{ type: 'mark_do_not_call' }]);
  assert.equal(decision.nextState, 'completed');
});

test('5 English HUMAN_AGENT', async () => {
  const { decision } = await decide('connect me to an agent');
  assert.equal(decision.intent, 'HUMAN_AGENT');
  assert.deepEqual(decision.actions, [
    { type: 'transfer_queue', queue: 'admissions' },
  ]);
});

test('6 Telugu SEND_DETAILS', async () => {
  const { decision } = await decide('వివరాలు పంపండి');
  assert.equal(decision.intent, 'SEND_DETAILS');
  assert.equal(decision.language, 'te');
  assert.equal(decision.actions[0]?.type, 'create_follow_up');
});

test('7 Telugu CALLBACK', async () => {
  const { decision } = await decide('రేపు కాల్ చేయండి');
  assert.equal(decision.intent, 'CALLBACK');
  assert.equal(decision.language, 'te');
});

test('8 Telugu DO_NOT_CALL', async () => {
  const { decision } = await decide('మళ్లీ కాల్ చేయవద్దు');
  assert.equal(decision.intent, 'DO_NOT_CALL');
  assert.equal(decision.actions[0]?.type, 'mark_do_not_call');
});

test('9 Transliterated Telugu phrase', async () => {
  const { decision } = await decide('details pampandi');
  assert.equal(decision.intent, 'SEND_DETAILS');
  assert.equal(decision.language, 'te');
});

test('10 Negative phrase does not become INTERESTED', async () => {
  const { decision } = await decide('i am not interested');
  assert.equal(decision.intent, 'NOT_INTERESTED');
  assert.notEqual(decision.intent, 'INTERESTED');
});

test('11 State changes interpretation of tomorrow', async () => {
  const sess = session();
  setConversationState(sess, CONVERSATION_STATES.waiting_for_demo_date);
  const { decision } = await decide('tomorrow evening', sess);
  assert.equal(decision.intent, 'BOOK_DEMO');
  assert.equal(decision.actions[0]?.type, 'create_demo_request');
  assert.equal(decision.entities.relativeDate, 'tomorrow');
});

test('12 Callback-time extraction', async () => {
  const sess = session();
  setConversationState(sess, CONVERSATION_STATES.waiting_for_callback_time);
  const { decision } = await decide('six in the evening', sess);
  assert.equal(decision.intent, 'CALLBACK_TIME');
  assert.equal(decision.actions[0]?.type, 'create_callback');
  assert.equal(decision.entities.time24h, '18:00');
});

test('13 Unknown attempt 1', async () => {
  const sess = session();
  const { decision } = await decide('asdf qwerty zxcv', sess);
  assert.equal(decision.intent, 'UNKNOWN');
  assert.equal(getUnknownCount(sess), 1);
  assert.match(decision.replyText, /repeat/i);
});

test('14 Unknown attempt 2', async () => {
  const sess = session();
  await decide('zzzz one', sess);
  const { decision } = await decide('zzzz two', sess);
  assert.equal(decision.intent, 'UNKNOWN');
  assert.equal(getUnknownCount(sess), 2);
  assert.match(decision.replyText, /demo|details|callback|agent/i);
});

test('15 Unknown attempt 3 with DTMF fallback', async () => {
  const sess = session();
  await decide('zzzz one', sess);
  await decide('zzzz two', sess);
  const { decision } = await decide('zzzz three', sess);
  assert.equal(decision.intent, 'UNKNOWN');
  assert.equal(getUnknownCount(sess), 3);
  assert.match(decision.replyText, /press 1/i);
  assert.deepEqual(decision.actions, [{ type: 'enable_dtmf_fallback' }]);
});

test('16 Unknown counter resets after valid intent', async () => {
  const sess = session();
  await decide('zzzz', sess);
  assert.equal(getUnknownCount(sess), 1);
  await decide('send details', sess);
  assert.equal(getUnknownCount(sess), 0);
  assert.equal(sess.metadata.lastIntent, 'SEND_DETAILS');
});

test('17 Separate sessions do not share state', async () => {
  const a = session();
  const b = session();
  await decide('call me later', a);
  assert.equal(getConversationState(a), 'waiting_for_callback_time');
  assert.equal(getConversationState(b), 'waiting_for_initial_response');
  assert.equal(getUnknownCount(b), 0);
});

test('18 VoicePipeline dependency injection still works', async () => {
  const mockAgent = new MockConversationAgent();
  const pipeline = new VoicePipeline({
    stt: new MockSpeechToText(),
    agent: mockAgent,
    tts: new MockTextToSpeech(),
  });
  assert.equal(pipeline.providerName, 'mock');
  const result = await pipeline.handleInboundAudio(Buffer.alloc(320, 0xff), {
    metadata: {},
  });
  assert.ok(result.reply?.replyText);
  assert.equal(result.reply.provider, 'mock-agent');
});

test('19 Mock STT → response engine → mock TTS integration', async () => {
  const pipeline = new VoicePipeline({
    agent: new AdmissionsResponseEngine(),
  });
  const sess = session();
  const result = await pipeline.handleInboundAudio(Buffer.alloc(320, 0x00), sess);
  assert.ok(result.transcript?.text);
  assert.ok(result.reply?.replyText);
  assert.ok(result.audio);
  assert.equal(result.reply.provider, 'deterministic-response-engine');
  assert.equal(result.reply.intent, 'INTERESTED');
});

test('20 Human-agent action remains compatible with transfer_queue', async () => {
  const { decision } = await decide('transfer the call');
  assert.equal(decision.intent, 'HUMAN_AGENT');
  const action = decision.actions[0];
  assert.equal(action.type, 'transfer_queue');
  assert.equal(action.queue, 'admissions');
});

test('createConversationAgent respects mock mode', () => {
  const agent = createConversationAgent('mock');
  assert.ok(agent instanceof MockConversationAgent);
  const det = createConversationAgent('deterministic');
  assert.ok(det instanceof AdmissionsResponseEngine);
});

test('config VOICE_RESPONSE_ENGINE defaults and validates', () => {
  const cfg = getConfig({ voiceResponseEngine: 'deterministic' });
  assert.equal(cfg.voiceResponseEngine, 'deterministic');
  const mockCfg = getConfig({ voiceResponseEngine: 'mock' });
  assert.equal(mockCfg.voiceResponseEngine, 'mock');
  const bad = getConfig({ voiceResponseEngine: 'openai' });
  assert.equal(bad.voiceResponseEngine, 'deterministic');
  const publicSettings = getPublicSettings(cfg, 'mock');
  assert.equal(publicSettings.voiceResponseEngine, 'deterministic');
});

test('do not send details is not SEND_DETAILS', async () => {
  const { decision } = await decide("don't send details");
  assert.notEqual(decision.intent, 'SEND_DETAILS');
});

test('metadata fields recorded on session', async () => {
  const sess = session();
  await decide('whatsapp me', sess);
  assert.equal(sess.metadata.lastIntent, 'SEND_DETAILS');
  assert.ok(sess.metadata.lastReplyText);
  assert.equal(sess.metadata.detectedLanguage, 'en');
  assert.ok(sess.metadata.conversationState);
  assert.equal(sess.metadata.unknownCount, 0);
});
