/**
 * Local speech conversation simulator (Phase 4E).
 * Connects to the SmartPing-compatible WebSocket. Never contacts SmartPing
 * and never places a telephone call.
 *
 * Usage:
 *   npm run simulate:local-speech -- --language en --scenario send_details
 *   npm run simulate:local-speech -- --language te --scenario callback
 */
import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import { AUDIO, MULAW_SILENCE, STREAM_PATH } from '../src/streaming/constants.js';

const SCENARIOS = {
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

function parseArgs(argv) {
  const out = {
    language: 'en',
    scenario: 'send_details',
    target: null,
    inputWav: null,
    turns: 1,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--language' && argv[i + 1]) out.language = argv[++i];
    else if (a === '--scenario' && argv[i + 1]) out.scenario = argv[++i];
    else if (a === '--target' && argv[i + 1]) out.target = argv[++i];
    else if ((a === '--url' || a === '--target-url') && argv[i + 1]) out.target = argv[++i];
    else if (a === '--input-wav' && argv[i + 1]) out.inputWav = argv[++i];
    else if (a === '--turns' && argv[i + 1]) out.turns = Number(argv[++i]);
  }
  return out;
}

function httpBaseFromWs(wsUrl) {
  const u = new URL(wsUrl);
  u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:';
  u.pathname = '';
  u.search = '';
  u.hash = '';
  return u.toString().replace(/\/$/, '');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
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
    callerAudioDurationMs: 0,
    botMedia: 0,
    marks: 0,
    inject: null,
    telephoneCalls: 0,
    networkExternalCalls: 0,
  };

  console.error(`Connecting local-speech simulator to ${wsUrl}`);
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
    if (msg.event === 'media') stats.botMedia += 1;
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
        },
      },
    }),
  );

  // Wait for greeting playback / listening transition.
  await sleep(400);

  // Optional short synthetic caller μ-law (not customer audio).
  // Keep under mock-STT threshold so inject remains the transcript source.
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
  stats.callerAudioDurationMs = Date.now() - startedAudio;

  // Inject deterministic transcript (simulation only; not real STT audio).
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
  stats.inject = await injectRes.json().catch(() => ({}));

  // Allow bot response μ-law to arrive.
  await sleep(1500);

  ws.send(
    JSON.stringify({
      event: 'stop',
      sequenceNumber: String(100),
      streamSid,
      stop: { accountSid: 'ACsim', callSid },
    }),
  );
  await sleep(200);
  ws.close();

  const report = {
    ok: injectRes.ok && stats.connection,
    language,
    scenario: args.scenario,
    expectedIntent: scenario.intent,
    connection: stats.connection,
    greetingReceived: stats.greetingMedia > 0 || stats.greetingMark,
    callerAudioDurationMs: stats.callerAudioDurationMs,
    transcript: scenario.text,
    intent: stats.inject?.intent || null,
    ttsProvider: stats.inject?.ttsProvider || null,
    voiceLifecycle: stats.inject?.voiceLifecycle || null,
    botMediaFrames: stats.botMedia,
    marks: stats.marks,
    inputWav: args.inputWav || null,
    note:
      'Synthetic TTS-to-STT / inject validation does not prove real-human recognition accuracy.',
    telephoneCalls: 0,
    networkExternalCalls: 0,
  };

  console.log(JSON.stringify(report, null, 2));
  if (!report.ok || (report.intent && report.intent !== report.expectedIntent && report.expectedIntent !== 'UNKNOWN')) {
    if (report.intent && report.intent !== report.expectedIntent && report.expectedIntent !== 'UNKNOWN') {
      console.error(`Intent mismatch: got ${report.intent}, expected ${report.expectedIntent}`);
      process.exit(1);
    }
    if (!report.ok) process.exit(1);
  }
  console.error('LOCAL_SPEECH_SIMULATOR_OK');
}

main().catch((err) => {
  console.error(JSON.stringify({ ok: false, error: err.message }));
  process.exit(1);
});
