/**
 * Local speech conversation simulator (Phase 4E / 4E.1).
 * Connects to the SmartPing-compatible WebSocket. Never contacts SmartPing
 * and never places a telephone call.
 *
 * Modes:
 *   inject — deterministic transcript injection (unit/logic)
 *   audio  — real μ-law media through Silero → Faster-Whisper → TTS
 *
 * Usage:
 *   npm run simulate:local-speech -- --mode inject --language en --scenario send_details
 *   npm run simulate:local-speech -- --mode audio --language en --scenario send_details
 *   npm run simulate:local-speech -- --mode audio --language te --scenario callback
 */
import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { AUDIO, MULAW_SILENCE, STREAM_PATH } from '../src/streaming/constants.js';
import { isValidMulaw8k } from './lib/wav-mulaw.mjs';

export const SCENARIOS = {
  en: {
    send_details: { text: 'Please send me the course details', intent: 'SEND_DETAILS' },
    book_demo: { text: 'I want to book a demo', intent: 'BOOK_DEMO' },
    callback: { text: 'Please call me back tomorrow', intent: 'CALLBACK' },
    not_interested: { text: 'I am not interested', intent: 'NOT_INTERESTED' },
    do_not_call: { text: 'Do not call me again', intent: 'DO_NOT_CALL' },
    human_agent: { text: 'I want to speak to an agent', intent: 'HUMAN_AGENT' },
    unknown_then_dtmf: { text: 'asdf qwerty zz', intent: 'UNKNOWN' },
  },
  te: {
    send_details: { text: 'వివరాలు పంపండి', intent: 'SEND_DETAILS' },
    callback: { text: 'రేపు కాల్ చేయండి', intent: 'CALLBACK' },
    not_interested: { text: 'నాకు ఆసక్తి లేదు', intent: 'NOT_INTERESTED' },
    do_not_call: { text: 'నాకు కాల్ చేయవద్దు', intent: 'DO_NOT_CALL' },
    unknown_then_dtmf: { text: 'zzzz qqqq', intent: 'UNKNOWN' },
  },
};

const EXPECTED_TTS = {
  en: { provider: 'kokoro-local', voice: 'af_bella' },
  te: { provider: 'piper-local', voice: 'te_IN-padmavathi-medium' },
};

export function parseArgs(argv) {
  const out = {
    mode: 'inject',
    language: 'en',
    scenario: 'send_details',
    target: null,
    inputWav: null,
    fixtureUlaw: null,
    turns: 1,
    timeoutMs: 90_000,
    keepFixture: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--mode' && argv[i + 1]) out.mode = argv[++i];
    else if (a === '--language' && argv[i + 1]) out.language = argv[++i];
    else if (a === '--scenario' && argv[i + 1]) out.scenario = argv[++i];
    else if (a === '--target' && argv[i + 1]) out.target = argv[++i];
    else if ((a === '--url' || a === '--target-url') && argv[i + 1]) out.target = argv[++i];
    else if (a === '--input-wav' && argv[i + 1]) out.inputWav = argv[++i];
    else if (a === '--fixture-ulaw' && argv[i + 1]) out.fixtureUlaw = argv[++i];
    else if (a === '--turns' && argv[i + 1]) out.turns = Number(argv[++i]);
    else if (a === '--timeout-ms' && argv[i + 1]) out.timeoutMs = Number(argv[++i]);
    else if (a === '--keep-fixture') out.keepFixture = true;
  }
  if (out.mode !== 'inject' && out.mode !== 'audio') {
    throw new Error(`Unsupported mode '${out.mode}' (use inject|audio)`);
  }
  return out;
}

export function httpBaseFromWs(wsUrl) {
  const u = new URL(wsUrl);
  u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:';
  u.pathname = '';
  u.search = '';
  u.hash = '';
  return u.toString().replace(/\/$/, '');
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function chunkMulaw(bytes, chunkBytes = AUDIO.chunkBytes) {
  const out = [];
  for (let i = 0; i < bytes.length; i += chunkBytes) {
    const slice = bytes.subarray(i, i + chunkBytes);
    if (slice.length === chunkBytes) {
      out.push(Buffer.from(slice));
    } else if (slice.length > 0) {
      const padded = Buffer.alloc(chunkBytes, MULAW_SILENCE);
      slice.copy(padded);
      out.push(padded);
    }
  }
  return out;
}

export async function sendPacedMulaw(ws, streamSid, mulawBytes, {
  chunkBytes = AUDIO.chunkBytes,
  intervalMs = AUDIO.chunkIntervalMs,
  startSequence = 2,
} = {}) {
  const frames = chunkMulaw(mulawBytes, chunkBytes);
  const started = Date.now();
  for (let i = 0; i < frames.length; i += 1) {
    ws.send(
      JSON.stringify({
        event: 'media',
        sequenceNumber: String(startSequence + i),
        streamSid,
        media: {
          track: 'inbound',
          chunk: String(i + 1),
          timestamp: String(i * intervalMs),
          payload: frames[i].toString('base64'),
        },
      }),
    );
    await sleep(intervalMs);
  }
  // Trailing silence helps VAD finalize.
  for (let i = 0; i < 15; i += 1) {
    const payload = Buffer.alloc(chunkBytes, MULAW_SILENCE);
    ws.send(
      JSON.stringify({
        event: 'media',
        sequenceNumber: String(startSequence + frames.length + i),
        streamSid,
        media: {
          track: 'inbound',
          chunk: String(frames.length + i + 1),
          timestamp: String((frames.length + i) * intervalMs),
          payload: payload.toString('base64'),
        },
      }),
    );
    await sleep(intervalMs);
  }
  return {
    framesSent: frames.length,
    frameBytes: chunkBytes,
    callerAudioDurationMs: Date.now() - started,
  };
}

async function generateFixture({ language, text, inputWav, keepFixture }) {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'local-speech-audio-'));
  const outUlaw = path.join(tempDir, 'caller.ulaw');
  const script = path.resolve('scripts/generate-synthetic-caller-fixture.mjs');
  const args = [script, '--language', language, '--out', outUlaw];
  if (inputWav) {
    args.push('--input-wav', inputWav);
  } else {
    args.push('--text', text);
  }
  const result = spawnSync(process.execPath, args, {
    encoding: 'utf8',
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(
      `fixture generator failed: ${result.stderr || result.stdout || result.status}`,
    );
  }
  const mulaw = readFileSync(outUlaw);
  return {
    mulaw,
    path: outUlaw,
    cleanup: () => {
      if (keepFixture) return;
      try {
        unlinkSync(outUlaw);
      } catch {
        // ignore
      }
    },
    generatorStdout: result.stdout,
  };
}

async function waitForListening(httpBase, streamSid, { timeoutMs = 60_000 } = {}) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    const res = await fetch(
      `${httpBase}/api/speech/session-turn?streamSid=${encodeURIComponent(streamSid)}`,
    );
    last = await res.json().catch(() => ({}));
    const life = last?.voiceLifecycle;
    if (
      res.ok &&
      (life === 'listening' ||
        life === 'speech_detected' ||
        life === 'waiting_for_next_turn')
    ) {
      return last;
    }
    await sleep(400);
  }
  return last;
}

async function waitForTurn(httpBase, streamSid, {
  timeoutMs,
  expectedIntent,
  language,
}) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    const res = await fetch(
      `${httpBase}/api/speech/session-turn?streamSid=${encodeURIComponent(streamSid)}`,
    );
    last = await res.json().catch(() => ({}));
    if (
      res.ok &&
      last?.transcript &&
      last?.intent &&
      (expectedIntent === 'UNKNOWN' || last.intent === expectedIntent)
    ) {
      return last;
    }
    if (
      res.ok &&
      last?.transcript &&
      last?.intent &&
      last.ttsProvider &&
      Date.now() - started > 5_000
    ) {
      // Intent may differ for synthetic Telugu; return once TTS completed.
      if (last.botMediaOut > 0 || last.voiceLifecycle === 'listening' || last.voiceLifecycle === 'speaking' || last.voiceLifecycle === 'closed' || last.completed) {
        return last;
      }
    }
    await sleep(400);
  }
  return last;
}

async function runInjectMode({
  ws,
  httpBase,
  streamSid,
  language,
  scenario,
  scenarioKey,
}) {
  const usedInject = true;
  await sleep(400);
  const frames = 1;
  const startedAudio = Date.now();
  for (let i = 0; i < frames; i += 1) {
    const payload = Buffer.alloc(AUDIO.chunkBytes, MULAW_SILENCE);
    payload[0] = 0x7f;
    ws.send(
      JSON.stringify({
        event: 'media',
        sequenceNumber: String(2 + i),
        streamSid,
        media: {
          track: 'inbound',
          chunk: String(i + 1),
          timestamp: String(i * 20),
          payload: payload.toString('base64'),
        },
      }),
    );
    await sleep(AUDIO.chunkIntervalMs);
  }

  const injectRes = await fetch(`${httpBase}/api/speech/inject-transcript`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      streamSid,
      text: scenario.text,
      language,
      provider: 'simulator-synthetic',
    }),
  });
  const inject = await injectRes.json().catch(() => ({}));
  await sleep(1500);

  return {
    usedInject,
    inject,
    injectOk: injectRes.ok,
    callerAudioDurationMs: Date.now() - startedAudio,
    transcript: scenario.text,
    intent: inject?.intent || null,
    ttsProvider: inject?.ttsProvider || null,
    voiceLifecycle: inject?.voiceLifecycle || null,
    turn: null,
    audioFramesSent: frames,
    frameBytes: AUDIO.chunkBytes,
  };
}

async function runAudioMode({
  ws,
  httpBase,
  streamSid,
  language,
  scenario,
  args,
}) {
  const usedInject = false;
  let fixtureCleanup = () => {};
  let mulaw;

  try {
    if (args.fixtureUlaw) {
      mulaw = readFileSync(args.fixtureUlaw);
    } else {
      const fixture = await generateFixture({
        language,
        text: scenario.text,
        inputWav: args.inputWav,
        keepFixture: args.keepFixture,
      });
      mulaw = fixture.mulaw;
      fixtureCleanup = fixture.cleanup;
    }

    if (!isValidMulaw8k(mulaw)) {
      throw new Error('Caller fixture is not valid μ-law audio');
    }

    // Wait until greeting finishes and lifecycle is listening.
    await waitForListening(httpBase, streamSid, { timeoutMs: 90_000 });
    const paced = await sendPacedMulaw(ws, streamSid, mulaw);

    const turn = await waitForTurn(httpBase, streamSid, {
      timeoutMs: args.timeoutMs,
      expectedIntent: scenario.intent,
      language,
    });

    return {
      usedInject,
      inject: null,
      injectOk: false,
      callerAudioDurationMs: paced.callerAudioDurationMs,
      transcript: turn?.transcript || null,
      intent: turn?.intent || null,
      ttsProvider: turn?.ttsProvider || null,
      ttsVoice: turn?.ttsVoice || null,
      voiceLifecycle: turn?.voiceLifecycle || null,
      turn,
      audioFramesSent: paced.framesSent,
      frameBytes: paced.frameBytes,
      speechStarted: Boolean(turn?.speechStarted),
      speechEnded: Boolean(turn?.speechEnded),
      detectedLanguage: turn?.detectedLanguage || null,
      timing: turn?.timing || null,
    };
  } finally {
    fixtureCleanup();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const language = args.language === 'te' ? 'te' : 'en';
  const scenarioPack = SCENARIOS[language];
  const scenario = scenarioPack[args.scenario];
  if (!scenario) {
    console.error(
      JSON.stringify({
        ok: false,
        error: `Unknown scenario ${args.scenario} for language ${language}`,
        available: Object.keys(scenarioPack),
      }),
    );
    process.exit(2);
  }

  const host = process.env.HOST ?? '127.0.0.1';
  const port = Number(process.env.PORT ?? 8787);
  const wsUrl =
    args.target ||
    process.env.SMARTPING_STREAM_URL ||
    `ws://${host}:${port}${STREAM_PATH}`;
  const httpBase = httpBaseFromWs(wsUrl);
  const streamSid = `MZ${randomUUID().replaceAll('-', '').slice(0, 32)}`;
  const callSid = `CA${randomUUID().replaceAll('-', '').slice(0, 32)}`;

  const stats = {
    connection: false,
    greetingMedia: 0,
    greetingMark: false,
    botMedia: 0,
    botMediaBytes: 0,
    marks: 0,
    telephoneCalls: 0,
    networkExternalCalls: 0,
  };

  console.error(`Connecting local-speech simulator (${args.mode}) to ${wsUrl}`);
  console.error('NOTE: Never contacts SmartPing; telephoneCalls remain 0.');

  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  stats.connection = true;

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (msg.event === 'media') {
      stats.botMedia += 1;
      const payload = msg.media?.payload;
      if (typeof payload === 'string') {
        stats.botMediaBytes += Buffer.from(payload, 'base64').length;
      }
    }
    if (msg.event === 'media' && !stats.greetingMark) stats.greetingMedia += 1;
    if (msg.event === 'mark') {
      stats.marks += 1;
      if (
        String(msg.mark?.name || msg.name || '').includes('complete') ||
        stats.greetingMedia > 0
      ) {
        stats.greetingMark = true;
      }
    }
  });

  ws.send(
    JSON.stringify({
      event: 'connected',
      protocol: 'Call',
      version: '1.0.0',
    }),
  );
  ws.send(
    JSON.stringify({
      event: 'start',
      sequenceNumber: '1',
      streamSid,
      start: {
        streamSid,
        callSid,
        tracks: ['inbound'],
        mediaFormat: {
          encoding: 'audio/x-mulaw',
          sampleRate: 8000,
          channels: 1,
        },
        customParameters: {
          language,
          source: 'local-speech-simulator',
          synthetic: 'true',
          mode: args.mode,
        },
      },
    }),
  );

  const turnResult =
    args.mode === 'audio'
      ? await runAudioMode({
          ws,
          httpBase,
          streamSid,
          language,
          scenario,
          args,
        })
      : await runInjectMode({
          ws,
          httpBase,
          streamSid,
          language,
          scenario,
          scenarioKey: args.scenario,
        });

  if (args.mode === 'audio' && turnResult.usedInject) {
    console.error(JSON.stringify({ ok: false, error: 'audio mode used inject' }));
    process.exit(1);
  }

  await sleep(args.mode === 'audio' ? 2500 : 200);

  ws.send(
    JSON.stringify({
      event: 'stop',
      sequenceNumber: String(100000),
      streamSid,
      stop: { accountSid: 'ACsim', callSid },
    }),
  );
  await sleep(200);
  ws.close();

  const expectedTts = EXPECTED_TTS[language];
  const botMulawValid =
    stats.botMediaBytes >= 160 && stats.botMediaBytes % 1 === 0;

  const intentOk =
    scenario.intent === 'UNKNOWN'
      ? true
      : turnResult.intent === scenario.intent;

  const providerOk =
    args.mode === 'inject'
      ? true
      : turnResult.ttsProvider === expectedTts.provider &&
        (!turnResult.ttsVoice || turnResult.ttsVoice === expectedTts.voice);

  const mockRejected =
    args.mode === 'audio' &&
    (String(turnResult.ttsProvider || '').includes('mock') ||
      String(turnResult.turn?.sttProvider || '').includes('mock'));

  const report = {
    ok:
      stats.connection &&
      (args.mode === 'inject' ? turnResult.injectOk : Boolean(turnResult.transcript)) &&
      intentOk &&
      providerOk &&
      !mockRejected &&
      stats.telephoneCalls === 0,
    mode: args.mode,
    language,
    scenario: args.scenario,
    expectedIntent: scenario.intent,
    expectedPhrase: scenario.text,
    actualTranscript: turnResult.transcript,
    expectedTtsProvider: expectedTts.provider,
    expectedTtsVoice: expectedTts.voice,
    connection: stats.connection,
    greetingReceived: stats.greetingMedia > 0 || stats.greetingMark,
    callerAudioDurationMs: turnResult.callerAudioDurationMs,
    audioFramesSent: turnResult.audioFramesSent,
    frameBytes: turnResult.frameBytes,
    usedTranscriptInject: turnResult.usedInject,
    speechStarted: turnResult.speechStarted ?? null,
    speechEnded: turnResult.speechEnded ?? null,
    detectedLanguage: turnResult.detectedLanguage ?? language,
    intent: turnResult.intent,
    ttsProvider: turnResult.ttsProvider,
    ttsVoice: turnResult.ttsVoice ?? null,
    voiceLifecycle: turnResult.voiceLifecycle,
    botMediaFrames: stats.botMedia,
    botMediaBytes: stats.botMediaBytes,
    botMulawValid,
    marks: stats.marks,
    timing: turnResult.timing || null,
    inputWav: args.inputWav || null,
    note:
      args.mode === 'audio'
        ? 'Synthetic TTS-to-STT validation does not prove real-human recognition accuracy.'
        : 'Inject mode validates conversation logic only; use --mode audio for real STT/TTS.',
    telephoneCalls: 0,
    networkExternalCalls: 0,
  };

  console.log(JSON.stringify(report, null, 2));

  if (args.mode === 'audio' && report.usedTranscriptInject) {
    console.error('FAIL: audio mode must not use transcript injection');
    process.exit(1);
  }
  if (!report.ok) {
    if (!intentOk) {
      console.error(
        `Intent mismatch: got ${report.intent}, expected ${report.expectedIntent}`,
      );
    }
    if (args.mode === 'audio' && !providerOk) {
      console.error(
        `TTS routing mismatch: got ${report.ttsProvider}/${report.ttsVoice}, expected ${expectedTts.provider}/${expectedTts.voice}`,
      );
    }
    if (mockRejected) {
      console.error('FAIL: mock STT/TTS is not allowed in audio mode');
    }
    process.exit(1);
  }
  console.error('LOCAL_SPEECH_SIMULATOR_OK');
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]).endsWith(
  'simulate-local-speech-conversation.mjs',
);

if (isDirectRun) {
  main().catch((err) => {
    console.error(JSON.stringify({ ok: false, error: err.message }));
    process.exit(1);
  });
}
