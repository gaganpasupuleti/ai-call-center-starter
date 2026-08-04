#!/usr/bin/env node
/**
 * Direct STT real-audio test — bypasses call-center app, conversation, and TTS.
 *
 *   node scripts/test-stt-stream-real-audio.mjs \
 *     --language en \
 *     --fixture-ulaw /tmp/codequest-speech-fixtures/en-send-details.ulaw
 */
import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { AUDIO } from '../src/streaming/constants.js';
import { buildStartMessage, buildStopMessage } from '../src/streaming/stt/protocol.js';
import { silenceFrameCount, makeSilenceFrame, chunkMulaw } from './lib/paced-media.mjs';
import { validateMulawFixture } from './lib/audio-fixture-validation.mjs';

function parseArgs(argv) {
  const out = {
    language: 'en',
    fixtureUlaw: null,
    url: process.env.STT_STREAM_URL || 'ws://127.0.0.1:8000/v1/stream',
    token: process.env.STT_SERVICE_TOKEN || '',
    preRollSilenceMs: Number(process.env.SIMULATOR_PRE_ROLL_SILENCE_MS || 200),
    trailingSilenceMs: Number(process.env.SIMULATOR_TRAILING_SILENCE_MS || 1200),
    timeoutMs: Number(process.env.STT_TRANSCRIPT_TIMEOUT_MS || 30_000),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--language' && argv[i + 1]) out.language = argv[++i];
    else if (a === '--fixture-ulaw' && argv[i + 1]) out.fixtureUlaw = argv[++i];
    else if (a === '--url' && argv[i + 1]) out.url = argv[++i];
    else if (a === '--token' && argv[i + 1]) out.token = argv[++i];
    else if (a === '--pre-roll-silence-ms' && argv[i + 1]) {
      out.preRollSilenceMs = Number(argv[++i]);
    } else if (a === '--trailing-silence-ms' && argv[i + 1]) {
      out.trailingSilenceMs = Number(argv[++i]);
    } else if (a === '--timeout-ms' && argv[i + 1]) out.timeoutMs = Number(argv[++i]);
  }
  return out;
}

function fail(code, extra = {}) {
  console.log(JSON.stringify({ ok: false, code, telephoneCalls: 0, ...extra }, null, 2));
  process.exit(1);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const language = args.language === 'te' ? 'te' : 'en';
  if (!args.fixtureUlaw || !existsSync(args.fixtureUlaw)) {
    fail('fixture_missing', { path: args.fixtureUlaw || null });
  }

  const mulaw = readFileSync(args.fixtureUlaw);
  const validation = validateMulawFixture(mulaw);
  if (!validation.valid) {
    fail('fixture_invalid', { reason: validation.reason, validation });
  }

  const streamSid = `MZ${randomUUID().replaceAll('-', '').slice(0, 32)}`;
  const headers = {};
  if (args.token) headers.Authorization = `Bearer ${args.token}`;

  const timings = {
    readyAt: null,
    speechStartedAt: null,
    speechEndedAt: null,
    transcriptAt: null,
  };
  let ready = false;
  let speechStarted = false;
  let speechEnded = false;
  let finalizeReason = null;
  let transcript = null;
  let transcriptLanguage = null;
  let inferenceDurationMs = null;
  let lastError = null;

  const ws = new WebSocket(args.url, { headers });
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });

  const messageWaiters = [];
  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    let msg;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    if (msg.type === 'ready') {
      ready = true;
      timings.readyAt = Date.now();
    } else if (msg.type === 'speech_started') {
      speechStarted = true;
      timings.speechStartedAt = Date.now();
    } else if (msg.type === 'speech_ended') {
      speechEnded = true;
      timings.speechEndedAt = Date.now();
      finalizeReason = msg.finalizeReason || null;
    } else if (msg.type === 'transcript') {
      transcript = String(msg.text || '').trim();
      transcriptLanguage = msg.language || null;
      inferenceDurationMs = msg.inferenceDurationMs ?? null;
      timings.transcriptAt = Date.now();
    } else if (msg.type === 'no_speech') {
      lastError = { code: 'stt_empty_transcript', reason: msg.reason };
    } else if (msg.type === 'error') {
      lastError = { code: msg.code || 'stt_error', message: msg.message };
    }
    for (const w of messageWaiters.splice(0)) w();
  });

  function waitUntil(pred, timeoutMs, code) {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const tick = () => {
        if (pred()) return resolve();
        if (Date.now() - started >= timeoutMs) {
          return reject(Object.assign(new Error(code), { code }));
        }
        messageWaiters.push(() => {
          if (pred()) resolve();
          else if (Date.now() - started >= timeoutMs) {
            reject(Object.assign(new Error(code), { code }));
          } else {
            setTimeout(tick, 50);
          }
        });
        setTimeout(() => {
          if (pred()) resolve();
          else if (Date.now() - started >= timeoutMs) {
            reject(Object.assign(new Error(code), { code }));
          }
        }, 50);
      };
      tick();
    });
  }

  ws.send(
    JSON.stringify(
      buildStartMessage({
        streamSid,
        language,
      }),
    ),
  );

  try {
    await waitUntil(() => ready, 15_000, 'stt_no_ready');
  } catch (err) {
    fail(err.code || 'stt_no_ready');
  }

  const preRoll = silenceFrameCount(args.preRollSilenceMs);
  const trailing = silenceFrameCount(args.trailingSilenceMs);
  const speechFrames = chunkMulaw(mulaw, AUDIO.chunkBytes);

  async function sendFrame(buf) {
    if (ws.readyState === WebSocket.OPEN) ws.send(buf);
    await sleep(AUDIO.chunkIntervalMs);
  }

  for (let i = 0; i < preRoll; i += 1) await sendFrame(makeSilenceFrame());
  for (const frame of speechFrames) await sendFrame(frame);
  for (let i = 0; i < trailing; i += 1) await sendFrame(makeSilenceFrame());

  try {
    await waitUntil(() => speechStarted, args.timeoutMs, 'stt_no_speech_started');
  } catch (err) {
    fail(err.code || 'stt_no_speech_started', { diagnosticsHint: 'no VAD speech_started' });
  }

  try {
    await waitUntil(() => speechEnded, args.timeoutMs, 'stt_no_speech_ended');
  } catch (err) {
    fail(err.code || 'stt_no_speech_ended');
  }

  try {
    await waitUntil(
      () => Boolean(transcript) || Boolean(lastError),
      args.timeoutMs,
      'stt_transcript_timeout',
    );
  } catch (err) {
    fail(err.code || 'stt_transcript_timeout');
  }

  if (lastError?.code === 'stt_empty_transcript' || (!transcript && lastError)) {
    fail('stt_empty_transcript', { lastError });
  }
  if (!transcript) {
    fail('stt_empty_transcript');
  }

  try {
    ws.send(JSON.stringify(buildStopMessage()));
  } catch {
    // ignore
  }
  await sleep(100);
  ws.close();

  const report = {
    ok: true,
    language,
    transcriptLanguage,
    transcriptChars: transcript.length,
    // Bound safe preview (authorized direct STT test)
    transcriptPreview: transcript.slice(0, 120),
    finalizeReason,
    speechStarted,
    speechEnded,
    inferenceDurationMs,
    timings: {
      speechEndToSpeechEndedMs:
        timings.speechEndedAt && timings.speechStartedAt
          ? timings.speechEndedAt - timings.speechStartedAt
          : null,
      speechEndedToTranscriptMs:
        timings.transcriptAt && timings.speechEndedAt
          ? timings.transcriptAt - timings.speechEndedAt
          : null,
      totalMs: timings.transcriptAt && timings.readyAt
        ? timings.transcriptAt - timings.readyAt
        : null,
    },
    preRollSilenceMs: args.preRollSilenceMs,
    trailingSilenceMs: args.trailingSilenceMs,
    trailingSilenceFrames: trailing,
    fixtureValidation: validation,
    telephoneCalls: 0,
  };
  console.log(JSON.stringify(report, null, 2));
}

main().catch((err) => {
  fail(err.code || 'stt_direct_error', { message: err.message });
});
