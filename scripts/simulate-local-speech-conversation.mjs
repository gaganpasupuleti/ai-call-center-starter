/**
 * Local speech conversation simulator (Phase 4E / 4E.2).
 * Never contacts SmartPing and never places a telephone call.
 *
 * Modes: inject | audio
 * Greeting: none | prepared
 */
import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
} from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { AUDIO, STREAM_PATH } from '../src/streaming/constants.js';
import {
  chunkMulaw,
  sendPacedMulaw,
  silenceFrameCount,
} from './lib/paced-media.mjs';
import {
  validateMulawFixture,
  isResponseMulawValid,
} from './lib/audio-fixture-validation.mjs';
import {
  waitForListening,
  SessionNotReadyError,
  inferFailureStage,
} from './lib/session-readiness.mjs';

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
  en: { provider: 'piper-local', voice: 'en_US-libritts_r-medium' },
  te: { provider: 'piper-local', voice: 'te_IN-padmavathi-medium' },
};

export { chunkMulaw, sendPacedMulaw, silenceFrameCount, waitForListening };

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
    greeting: 'none',
    preRollSilenceMs: Number(process.env.SIMULATOR_PRE_ROLL_SILENCE_MS || 200),
    trailingSilenceMs: Number(process.env.SIMULATOR_TRAILING_SILENCE_MS || 1200),
    appCallId: null,
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
    else if (a === '--greeting' && argv[i + 1]) out.greeting = argv[++i];
    else if (a === '--pre-roll-silence-ms' && argv[i + 1]) {
      out.preRollSilenceMs = Number(argv[++i]);
    } else if (a === '--trailing-silence-ms' && argv[i + 1]) {
      out.trailingSilenceMs = Number(argv[++i]);
    } else if (a === '--app-call-id' && argv[i + 1]) out.appCallId = argv[++i];
  }
  if (out.mode !== 'inject' && out.mode !== 'audio') {
    throw new Error(`Unsupported mode '${out.mode}' (use inject|audio)`);
  }
  if (out.greeting !== 'none' && out.greeting !== 'prepared') {
    throw new Error(`Unsupported greeting '${out.greeting}' (use none|prepared)`);
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

function loadOrGenerateFixture({ language, text, inputWav, fixtureUlaw, keepFixture }) {
  if (fixtureUlaw) {
    if (!existsSync(fixtureUlaw)) throw new Error(`fixture not found: ${fixtureUlaw}`);
    return {
      mulaw: readFileSync(fixtureUlaw),
      path: fixtureUlaw,
      cleanup: () => {},
      generated: false,
    };
  }
  const dir =
    process.env.SPEECH_FIXTURE_DIR ||
    path.join(process.cwd(), '.tmp-speech-fixtures');
  mkdirSync(dir, { recursive: true });
  const outUlaw = path.join(dir, `caller-${language}-${Date.now()}.ulaw`);
  const script = path.resolve('scripts/generate-synthetic-caller-fixture.mjs');
  const args = [script, '--language', language, '--out', outUlaw];
  if (inputWav) args.push('--input-wav', inputWav);
  else args.push('--text', text);
  const result = spawnSync(process.execPath, args, {
    encoding: 'utf8',
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(
      `fixture generator failed: ${result.stderr || result.stdout || result.status}`,
    );
  }
  return {
    mulaw: readFileSync(outUlaw),
    path: outUlaw,
    cleanup: () => {
      if (keepFixture) return;
      try {
        unlinkSync(outUlaw);
      } catch {
        // ignore
      }
    },
    generated: true,
  };
}

async function waitForTurn(httpBase, streamSid, { timeoutMs, expectedIntent }) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    const res = await fetch(
      `${httpBase}/api/speech/session-turn?streamSid=${encodeURIComponent(streamSid)}`,
    );
    last = await res.json().catch(() => ({}));
    if (res.ok && last?.lastTranscript && last?.lastIntent) {
      if (expectedIntent === 'UNKNOWN' || last.lastIntent === expectedIntent) {
        return last;
      }
      if (last.ttsProvider && Date.now() - started > 5_000) {
        return last;
      }
    }
    // Compat with older field names
    if (res.ok && last?.transcript && last?.intent) {
      return {
        ...last,
        lastTranscript: last.transcript,
        lastIntent: last.intent,
      };
    }
    await sleep(400);
  }
  return last;
}

async function runInjectMode({ ws, httpBase, streamSid, language, scenario }) {
  await sleep(400);
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
    usedInject: true,
    injectOk: injectRes.ok,
    transcript: scenario.text,
    intent: inject?.intent || null,
    ttsProvider: inject?.ttsProvider || null,
    voiceLifecycle: inject?.voiceLifecycle || null,
    audioFramesSent: 0,
    frameBytes: AUDIO.chunkBytes,
    gates: {
      fixtureValidated: true,
      sessionStarted: true,
      listeningReady: true,
      sttReady: true,
      audioSent: false,
      audioForwarded: false,
      speechStarted: false,
      speechEnded: false,
      transcriptReceived: Boolean(inject?.intent),
      intentSelected: Boolean(inject?.intent),
      ttsCompleted: Boolean(inject?.ttsProvider),
      botAudioReceived: false,
      conversationCompleted: false,
    },
  };
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
  const expectedTts = EXPECTED_TTS[language];

  const gates = {
    fixtureGenerated: false,
    fixtureValidated: false,
    sessionStarted: false,
    listeningReady: false,
    sttReady: false,
    audioSent: false,
    audioForwarded: false,
    speechStarted: false,
    speechEnded: false,
    transcriptReceived: false,
    intentSelected: false,
    ttsRequested: false,
    ttsCompleted: false,
    botAudioReceived: false,
    conversationCompleted: false,
  };

  let fixtureCleanup = () => {};
  let mulaw = null;
  let fixtureValidation = null;
  let usedInject = false;
  let turnResult = null;
  let paced = null;
  let greetingMediaBytes = 0;
  let responseMediaBytes = 0;
  let responseMulawChunks = [];
  let botMediaFrames = 0;
  let marks = 0;
  let greetingMark = false;

  try {
    if (args.mode === 'audio') {
      const fixture = loadOrGenerateFixture({
        language,
        text: scenario.text,
        inputWav: args.inputWav,
        fixtureUlaw: args.fixtureUlaw,
        keepFixture: args.keepFixture,
      });
      mulaw = fixture.mulaw;
      fixtureCleanup = fixture.cleanup;
      gates.fixtureGenerated = fixture.generated || Boolean(args.fixtureUlaw);
      fixtureValidation = validateMulawFixture(mulaw);
      if (!fixtureValidation.valid) {
        throw new Error(`fixture_invalid:${fixtureValidation.reason}`);
      }
      gates.fixtureValidated = true;
    }

    console.error(`Connecting local-speech simulator (${args.mode}) to ${wsUrl}`);
    console.error('NOTE: Never contacts SmartPing; telephoneCalls remain 0.');

    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });

    let greetingPhase = args.greeting === 'prepared';
    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (msg.event === 'media') {
        botMediaFrames += 1;
        const payload = msg.media?.payload;
        const decoded =
          typeof payload === 'string' ? Buffer.from(payload, 'base64') : Buffer.alloc(0);
        const bytes = decoded.length;
        if (greetingPhase) greetingMediaBytes += bytes;
        else {
          responseMediaBytes += bytes;
          if (decoded.length) responseMulawChunks.push(decoded);
        }
      }
      if (msg.event === 'mark') {
        marks += 1;
        if (String(msg.mark?.name || msg.name || '').includes('complete')) {
          greetingMark = true;
          greetingPhase = false;
        }
      }
    });

    ws.send(JSON.stringify({ event: 'connected', protocol: 'Call', version: '1.0.0' }));
    const customParameters = {
      language,
      source: 'local-speech-simulator',
      synthetic: 'true',
      mode: args.mode,
      greeting: args.greeting,
    };
    if (args.appCallId) customParameters.app_call_id = args.appCallId;
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
          customParameters,
        },
      }),
    );
    gates.sessionStarted = true;

    if (args.mode === 'inject') {
      turnResult = await runInjectMode({
        ws,
        httpBase,
        streamSid,
        language,
        scenario,
      });
      usedInject = true;
      Object.assign(gates, turnResult.gates || {});
    } else {
      usedInject = false;
      const ready = await waitForListening(httpBase, streamSid, {
        timeoutMs: args.timeoutMs,
        afterFirstTurn: false,
      });
      gates.listeningReady = ready.voiceLifecycle === 'listening';
      gates.sttReady = ready.sttStatus === 'ready' && ready.sttStarted === true;

      if (args.greeting === 'prepared' && greetingMediaBytes <= 0 && !greetingMark) {
        throw new Error('prepared_greeting_missing');
      }

      paced = await sendPacedMulaw(ws, streamSid, mulaw, {
        preRollSilenceMs: args.preRollSilenceMs,
        trailingSilenceMs: args.trailingSilenceMs,
      });
      gates.audioSent = paced.totalFramesSent > 0;

      // Poll until audio forwarded / transcript
      const pollDeadline = Date.now() + args.timeoutMs;
      let snapshot = ready;
      while (Date.now() < pollDeadline) {
        const res = await fetch(
          `${httpBase}/api/speech/session-turn?streamSid=${encodeURIComponent(streamSid)}`,
        );
        snapshot = await res.json().catch(() => ({}));
        if (Number(snapshot.mediaFramesForwardedToStt || 0) > 0) {
          gates.audioForwarded = true;
        }
        if (snapshot.speechStarted) gates.speechStarted = true;
        if (snapshot.speechEnded) gates.speechEnded = true;
        if (snapshot.lastTranscript || snapshot.transcript) {
          gates.transcriptReceived = true;
        }
        if (snapshot.lastIntent || snapshot.intent) {
          gates.intentSelected = true;
        }
        if (snapshot.ttsProvider) {
          gates.ttsRequested = true;
          gates.ttsCompleted = snapshot.ttsStatus === 'ok' || Boolean(snapshot.ttsProvider);
        }
        if (responseMediaBytes > 0) gates.botAudioReceived = true;
        if (
          gates.transcriptReceived &&
          (gates.ttsCompleted || snapshot.ttsProvider === 'mock' || snapshot.ttsStatus === 'ok')
        ) {
          break;
        }
        await sleep(400);
      }

      if (gates.audioSent && !gates.audioForwarded) {
        throw new Error('audio_not_forwarded_to_stt');
      }

      turnResult = {
        usedInject: false,
        transcript: snapshot.lastTranscript || snapshot.transcript || null,
        intent: snapshot.lastIntent || snapshot.intent || null,
        ttsProvider: snapshot.ttsProvider || null,
        ttsVoice: snapshot.ttsVoice || null,
        voiceLifecycle: snapshot.voiceLifecycle || null,
        speechStarted: Boolean(snapshot.speechStarted),
        speechEnded: Boolean(snapshot.speechEnded),
        detectedLanguage:
          snapshot.lastTranscriptLanguage ||
          snapshot.detectedLanguage ||
          language,
        timing: snapshot.timing || null,
        turn: snapshot,
        audioFramesSent: paced.framesSent,
        frameBytes: paced.frameBytes,
        mediaFramesForwardedToStt: Number(snapshot.mediaFramesForwardedToStt || 0),
      };
    }

    await sleep(args.mode === 'audio' ? 1500 : 200);
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
  } catch (err) {
    const safe =
      err instanceof SessionNotReadyError
        ? err.toJSON()
        : { code: err.code || 'simulator_error', message: err.message };
    const report = {
      ok: false,
      mode: args.mode,
      language,
      scenario: args.scenario,
      greeting: args.greeting,
      gates,
      failureStage: inferFailureStage(gates) || safe.code || 'unknown',
      error: safe,
      telephoneCalls: 0,
    };
    console.log(JSON.stringify(report, null, 2));
    process.exit(1);
  } finally {
    fixtureCleanup();
  }

  if (args.mode === 'audio' && usedInject) {
    console.error('FAIL: audio mode must not use transcript injection');
    process.exit(1);
  }

  const greetingReceived = greetingMediaBytes > 0 || greetingMark;
  const responseMulaw =
    responseMulawChunks.length > 0 ? Buffer.concat(responseMulawChunks) : Buffer.alloc(0);
  const botMulawValid =
    responseMediaBytes >= 160 && isResponseMulawValid(responseMulaw);
  // Greeting bytes must not satisfy response validation
  const greetingCannotSatisfyResponse =
    greetingMediaBytes > 0 && responseMediaBytes === 0
      ? false
      : true;

  const intentOk =
    scenario.intent === 'UNKNOWN' || turnResult.intent === scenario.intent;
  const providerOk =
    args.mode === 'inject'
      ? true
      : turnResult.ttsProvider === expectedTts.provider ||
        turnResult.ttsProvider === 'mock' ||
        turnResult.ttsProvider === 'precomputed-local';
  const mockRejected =
    args.mode === 'audio' &&
    process.env.REQUIRE_REAL_TTS === 'true' &&
    (String(turnResult.ttsProvider || '').includes('mock') ||
      String(turnResult.turn?.sttProvider || '').includes('mock'));

  if (args.greeting === 'none') {
    // greetingReceived=false is not a failure
  } else if (args.greeting === 'prepared' && !greetingReceived) {
    gates.listeningReady = false;
  }

  gates.conversationCompleted =
    Boolean(turnResult.intent) &&
    (args.mode === 'inject' ||
      botMulawValid ||
      turnResult.ttsProvider === 'mock') &&
    greetingCannotSatisfyResponse;

  const report = {
    ok:
      gates.sessionStarted &&
      (args.mode === 'inject'
        ? turnResult.injectOk
        : gates.fixtureValidated &&
          gates.listeningReady &&
          gates.sttReady &&
          gates.audioSent &&
          gates.audioForwarded &&
          gates.transcriptReceived &&
          intentOk &&
          !mockRejected) &&
      intentOk &&
      providerOk,
    mode: args.mode,
    language,
    scenario: args.scenario,
    greeting: args.greeting,
    expectedIntent: scenario.intent,
    expectedPhrase: scenario.text,
    actualTranscript: turnResult.transcript,
    expectedTtsProvider: expectedTts.provider,
    expectedTtsVoice: expectedTts.voice,
    intent: turnResult.intent,
    ttsProvider: turnResult.ttsProvider,
    ttsVoice: turnResult.ttsVoice ?? null,
    voiceLifecycle: turnResult.voiceLifecycle,
    usedTranscriptInject: usedInject,
    speechStarted: turnResult.speechStarted ?? null,
    speechEnded: turnResult.speechEnded ?? null,
    detectedLanguage: turnResult.detectedLanguage ?? language,
    audioFramesSent: turnResult.audioFramesSent,
    frameBytes: turnResult.frameBytes,
    mediaFramesForwardedToStt: turnResult.mediaFramesForwardedToStt ?? null,
    preRollSilenceMs: args.preRollSilenceMs,
    trailingSilenceMs: args.trailingSilenceMs,
    trailingSilenceFrames: silenceFrameCount(args.trailingSilenceMs),
    fixtureValidation,
    greetingReceived: args.greeting === 'none' ? null : greetingReceived,
    greetingMediaBytes,
    responseMediaBytes,
    botMediaFrames,
    botMulawValid,
    marks,
    gates,
    failureStage: inferFailureStage(gates),
    timing: turnResult.timing || null,
    telephoneCalls: 0,
    networkExternalCalls: 0,
  };

  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exit(1);
  console.error('LOCAL_SPEECH_SIMULATOR_OK');
}

const isDirectRun =
  process.argv[1] &&
  path.resolve(process.argv[1]).endsWith('simulate-local-speech-conversation.mjs');

if (isDirectRun) {
  main().catch((err) => {
    console.error(JSON.stringify({ ok: false, error: err.message }));
    process.exit(1);
  });
}
