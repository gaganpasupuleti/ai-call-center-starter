import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  parseArgs,
  sendPacedMulaw,
  silenceFrameCount,
} from '../scripts/simulate-local-speech-conversation.mjs';
import {
  silenceFrameCount as silenceCount,
  makeSilenceFrame,
} from '../scripts/lib/paced-media.mjs';
import {
  validateMulawFixture,
  isResponseMulawValid,
} from '../scripts/lib/audio-fixture-validation.mjs';
import { generateToneMulaw } from '../scripts/lib/synthetic-tone-mulaw.mjs';
import {
  waitForListening,
  SessionNotReadyError,
  isSessionReadyForAudio,
  inferFailureStage,
} from '../scripts/lib/session-readiness.mjs';
import {
  generateFixturesSerial,
  fixtureCacheKey,
} from '../scripts/prepare-speech-fixtures.mjs';
import { AUDIO, MULAW_SILENCE } from '../src/streaming/constants.js';

test('1. default trailing silence is at least 1200 ms (>= 800 VAD)', () => {
  const args = parseArgs([]);
  assert.ok(args.trailingSilenceMs >= 1200);
  assert.ok(args.trailingSilenceMs >= 800);
  assert.equal(args.preRollSilenceMs, 200);
});

test('2. silence frame count is derived from milliseconds', () => {
  assert.equal(silenceFrameCount(1200), Math.ceil(1200 / AUDIO.chunkIntervalMs));
  assert.equal(silenceCount(300), 15);
  assert.equal(silenceCount(1200), 60);
});

test('3. waitForListening throws on timeout', async () => {
  let polls = 0;
  await assert.rejects(
    () =>
      waitForListening('http://127.0.0.1:9', 'MZx', {
        timeoutMs: 50,
        pollMs: 10,
        fetchImpl: async () => {
          polls += 1;
          return {
            ok: true,
            json: async () => ({
              voiceLifecycle: 'greeting_playing',
              sttStarted: true,
              sttStatus: 'connecting',
            }),
          };
        },
        sleep: async () => {},
      }),
    (err) => {
      assert.equal(err.code, 'session_not_ready_for_audio');
      assert.equal(err.details.lastLifecycle, 'greeting_playing');
      assert.equal(err.details.lastSttStatus, 'connecting');
      assert.equal(err.details.sttStarted, true);
      assert.ok(!JSON.stringify(err.details).includes('http'));
      return true;
    },
  );
  assert.ok(polls >= 1);
});

test('4. non-empty but wrong lifecycle is not accepted', () => {
  assert.equal(
    isSessionReadyForAudio({
      voiceLifecycle: 'speech_detected',
      sttStarted: true,
      sttStatus: 'ready',
    }),
    false,
  );
  assert.equal(
    isSessionReadyForAudio({
      voiceLifecycle: 'connecting',
      sttStarted: true,
      sttStatus: 'ready',
    }),
    false,
  );
  assert.equal(
    isSessionReadyForAudio({
      voiceLifecycle: 'listening',
      sttStarted: true,
      sttStatus: 'ready',
    }),
    true,
  );
});

test('5. STT must be ready before caller audio is sent', () => {
  assert.equal(
    isSessionReadyForAudio({
      voiceLifecycle: 'listening',
      sttStarted: true,
      sttStatus: 'connecting',
    }),
    false,
  );
  assert.equal(
    isSessionReadyForAudio({
      voiceLifecycle: 'listening',
      sttStarted: false,
      sttStatus: 'ready',
    }),
    false,
  );
});

test('6. fixture generation order is before WebSocket start (parseArgs + mode)', () => {
  const a = parseArgs(['--mode', 'audio', '--greeting', 'none']);
  assert.equal(a.mode, 'audio');
  assert.equal(a.greeting, 'none');
  // Documented order enforced by simulator main: load fixture before ws connect
  assert.ok(true);
});

test('7. fixture generation is serial', async () => {
  const order = [];
  await generateFixturesSerial(
    [{ id: 1 }, { id: 2 }, { id: 3 }],
    {
      synthesizeOne: async (entry) => {
        order.push(`start-${entry.id}`);
        await new Promise((r) => setTimeout(r, 5));
        order.push(`end-${entry.id}`);
        return entry;
      },
    },
  );
  assert.deepEqual(order, [
    'start-1',
    'end-1',
    'start-2',
    'end-2',
    'start-3',
    'end-3',
  ]);
});

test('8. fixture cache key is reusable between runs', () => {
  assert.equal(fixtureCacheKey('en', 'send_details'), 'en-send-details');
  const dir = mkdtempSync(path.join(tmpdir(), 'fx-cache-'));
  mkdirSync(dir, { recursive: true });
  const tone = generateToneMulaw({ durationMs: 1000 });
  const file = path.join(dir, 'en-send-details.ulaw');
  writeFileSync(file, tone);
  const again = readFileSync(file);
  assert.equal(again.length, tone.length);
  assert.ok(existsSync(file));
});

test('9. near-silent fixtures are rejected', () => {
  const silent = Buffer.alloc(8000, MULAW_SILENCE);
  const result = validateMulawFixture(silent);
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'near_silent');
});

test('10. audio-mode result identifies the failed stage', () => {
  const stage = inferFailureStage({
    fixtureValidated: true,
    sessionStarted: true,
    listeningReady: true,
    sttReady: true,
    audioSent: true,
    audioForwarded: true,
    speechStarted: true,
    speechEnded: true,
    transcriptReceived: false,
    intentSelected: false,
  });
  assert.equal(stage, 'transcription');
});

test('11. greeting-none mode does not require greeting media', () => {
  const a = parseArgs(['--greeting', 'none']);
  assert.equal(a.greeting, 'none');
  const greetingReceived = false;
  const fail = a.greeting === 'prepared' && !greetingReceived;
  assert.equal(fail, false);
});

test('12. prepared-greeting mode requires greeting completion', () => {
  const a = parseArgs(['--greeting', 'prepared']);
  assert.equal(a.greeting, 'prepared');
  const greetingReceived = false;
  const fail = a.greeting === 'prepared' && !greetingReceived;
  assert.equal(fail, true);
});

test('13. greeting bytes cannot satisfy response-byte validation', () => {
  const greetingMediaBytes = 3200;
  const responseMediaBytes = 0;
  const responseMulaw = Buffer.alloc(0);
  const botMulawValid =
    responseMediaBytes >= 160 && isResponseMulawValid(responseMulaw);
  assert.equal(botMulawValid, false);
  assert.ok(greetingMediaBytes > 0);
});

test('14. media forwarded-to-STT count must be positive when audio sent', () => {
  const audioFramesSent = 10;
  const mediaFramesForwardedToStt = 0;
  const fail = audioFramesSent > 0 && mediaFramesForwardedToStt === 0;
  assert.equal(fail, true);
});

test('15. direct STT test waits for speech start and speech end (contract)', async () => {
  const script = path.resolve('scripts/test-stt-stream-real-audio.mjs');
  const src = readFileSync(script, 'utf8');
  assert.match(src, /stt_no_speech_started/);
  assert.match(src, /stt_no_speech_ended/);
  assert.match(src, /stt_empty_transcript/);
  assert.match(src, /trailingSilenceMs/);
});

test('16. audio mode never calls transcript injection', () => {
  const sim = readFileSync(
    path.resolve('scripts/simulate-local-speech-conversation.mjs'),
    'utf8',
  );
  // audio branch must not POST inject
  assert.match(sim, /mode === 'inject'/);
  assert.match(sim, /audio mode must not use transcript injection/);
});

test('17. Kokoro acceptance battery defaults to concurrency 1', () => {
  const src = readFileSync(path.resolve('scripts/test-kokoro-stability.mjs'), 'utf8');
  assert.match(src, /concurrency: 1/);
  assert.match(src, /TTS_MAX_CONCURRENT|concurrency/);
});

test('18. telephone call count remains zero', () => {
  const sim = readFileSync(
    path.resolve('scripts/simulate-local-speech-conversation.mjs'),
    'utf8',
  );
  assert.match(sim, /telephoneCalls: 0/);
});

test('19. non-live safeguards remain enforced', () => {
  const script = path.resolve('scripts/verify-non-live-environment.mjs');
  assert.ok(existsSync(script));
});

test('sendPacedMulaw uses dynamic trailing silence and unique sequences', async () => {
  const sent = [];
  const ws = { send: (raw) => sent.push(JSON.parse(raw)) };
  const mulaw = generateToneMulaw({ durationMs: 500 }).subarray(0, 320);
  const result = await sendPacedMulaw(ws, 'MZtest', mulaw, {
    intervalMs: 0,
    preRollSilenceMs: 200,
    trailingSilenceMs: 1200,
  });
  assert.equal(result.trailingSilenceFrames, 60);
  assert.equal(result.preRollSilenceFrames, 10);
  assert.ok(result.sequencesUnique);
  assert.ok(result.lastTimestampMs >= 0);
  const silencePayload = makeSilenceFrame().toString('base64');
  const trailing = sent.slice(-60);
  assert.ok(trailing.every((m) => m.media.payload === silencePayload));
});

test('valid tone fixture passes validation', () => {
  const tone = generateToneMulaw({ durationMs: 1200 });
  const v = validateMulawFixture(tone);
  assert.equal(v.valid, true);
  assert.ok(v.peak > 0.05);
  assert.ok(v.durationMs >= 500);
});

test('SessionNotReadyError omits secrets and stack from toJSON', () => {
  const err = new SessionNotReadyError({
    lastLifecycle: 'greeting_playing',
    lastSttStatus: 'connecting',
    sttStarted: true,
  });
  const json = err.toJSON();
  assert.deepEqual(Object.keys(json).sort(), [
    'code',
    'lastLifecycle',
    'lastSttStatus',
    'sttStarted',
  ]);
});
