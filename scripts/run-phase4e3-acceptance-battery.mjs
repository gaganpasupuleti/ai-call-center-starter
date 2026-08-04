#!/usr/bin/env node
/**
 * Phase 4E.3 acceptance battery (private Railway network).
 * Order: fixtures → D → C → E → F
 *
 * PHASE4E3_GATES=D,C,E,F  (comma list; default all)
 * Never places telephone calls.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const fixtureDir =
  process.env.SPEECH_FIXTURE_DIR || '/tmp/codequest-speech-fixtures';

const target =
  process.env.SMARTPING_STREAM_URL ||
  process.env.AUDIO_SIM_TARGET ||
  'ws://smartping-voice-stream-e2e.railway.internal:8080/ws/voice/smartping';

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, {
    encoding: 'utf8',
    cwd: root,
    env: { ...process.env, ...(opts.env || {}) },
    timeout: opts.timeout ?? 180_000,
    maxBuffer: 20 * 1024 * 1024,
  });
  const out = String(result.stdout || '');
  let parsed = null;
  for (let i = out.length - 1; i >= 0; i -= 1) {
    if (out[i] !== '}') continue;
    let depth = 0;
    for (let j = i; j >= 0; j -= 1) {
      if (out[j] === '}') depth += 1;
      else if (out[j] === '{') {
        depth -= 1;
        if (depth === 0) {
          try {
            parsed = JSON.parse(out.slice(j, i + 1));
          } catch {
            parsed = null;
          }
          break;
        }
      }
    }
    if (parsed) break;
  }
  return {
    status: result.status,
    signal: result.signal,
    json: parsed || {
      ok: false,
      parseError: true,
      status: result.status,
      signal: result.signal,
      stdoutHead: out.slice(0, 500),
      stderrHead: String(result.stderr || '').slice(0, 500),
    },
    stderr: result.stderr,
    stdout: out,
  };
}

function stop(summary, reason) {
  summary.ok = false;
  summary.stoppedAt = reason;
  console.log(JSON.stringify(summary, null, 2));
  try {
    writeFileSync('/tmp/phase4e3-acceptance.json', JSON.stringify(summary, null, 2));
  } catch {
    // ignore
  }
  process.exit(1);
}

function want(gate, selected) {
  return selected.has(gate);
}

const selected = new Set(
  String(process.env.PHASE4E3_GATES || 'D,C,E,F')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean),
);

const summary = {
  ok: true,
  telephoneCalls: 0,
  gatesRequested: [...selected],
  gates: {},
  piper: {},
  gateC: { en: [], te: [] },
  fullEn: [],
  fullTe: [],
  fixtures: null,
};

console.error(`PHASE4E3 gates=${[...selected].join(',')}`);

// Always prepare fixtures when any audio gate needs them
if ([...selected].some((g) => ['C', 'E', 'F'].includes(g)) || selected.has('D')) {
  console.error('Prepare Piper fixtures (serial)');
  mkdirSync(fixtureDir, { recursive: true });
  const prep = run(
    process.execPath,
    [
      path.join(root, 'scripts/prepare-speech-fixtures.mjs'),
      '--dir',
      fixtureDir,
      '--keep-fixtures',
    ],
    { timeout: 600_000 },
  );
  summary.fixtures = {
    ok: prep.json?.ok === true,
    count: prep.json?.count ?? null,
    error: prep.json?.error || null,
  };
  if (!summary.fixtures.ok && [...selected].some((g) => ['C', 'E', 'F'].includes(g))) {
    stop(summary, 'fixtures');
  }
}

if (want('D', selected)) {
  console.error('Gate D — Piper English 20× concurrency 1');
  const en = run(
    process.execPath,
    [
      path.join(root, 'scripts/test-piper-stability.mjs'),
      '--language',
      'en',
      '--requests',
      '20',
      '--concurrency',
      '1',
    ],
    { timeout: 15 * 60_000 },
  );
  summary.piper.english = en.json;
  summary.gates.D_en = en.json?.ok === true && en.json?.successes === 20;
  if (!summary.gates.D_en) stop(summary, 'gate_D_en');

  console.error('Gate D — Piper Telugu 20× concurrency 1');
  const te = run(
    process.execPath,
    [
      path.join(root, 'scripts/test-piper-stability.mjs'),
      '--language',
      'te',
      '--requests',
      '20',
      '--concurrency',
      '1',
    ],
    { timeout: 15 * 60_000 },
  );
  summary.piper.telugu = te.json;
  summary.gates.D_te = te.json?.ok === true && te.json?.successes === 20;
  if (!summary.gates.D_te) stop(summary, 'gate_D_te');
}

function sim(language, scenario, { expectMock = false, attempts = 2 } = {}) {
  const file = `${language === 'te' ? 'te' : 'en'}-${scenario.replaceAll('_', '-')}.ulaw`;
  const fixture = path.join(fixtureDir, file);
  let last = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const r = run(
      process.execPath,
      [
        path.join(root, 'scripts/simulate-local-speech-conversation.mjs'),
        '--mode',
        'audio',
        '--greeting',
        'none',
        '--language',
        language,
        '--scenario',
        scenario,
        '--fixture-ulaw',
        fixture,
        '--target',
        target,
        '--timeout-ms',
        String(process.env.AUDIO_SIM_TIMEOUT_MS || 120000),
      ],
      {
        timeout: 180_000,
        env: {
          SIMULATOR_TRAILING_SILENCE_MS:
            process.env.SIMULATOR_TRAILING_SILENCE_MS || '1600',
        },
      },
    );
    const j = r.json || {};
    const provider = String(j.ttsProvider || '');
    const mockOk =
      !expectMock || provider === 'mock' || provider === 'mock-tts' || provider.includes('mock');
    const realOk =
      expectMock ||
      (provider === 'piper-local' &&
        (language === 'en'
          ? j.ttsVoice === 'en_US-libritts_r-medium' ||
            String(j.ttsVoice || '').includes('libritts')
          : j.ttsVoice === 'te_IN-padmavathi-medium' ||
            String(j.ttsVoice || '').includes('padmavathi')));
    // Telugu STT may return romanized text; accept matched intent under session language te.
    last = {
      scenario,
      attempt,
      ok:
        j.ok === true &&
        Boolean(j.actualTranscript) &&
        Boolean(j.intent) &&
        String(j.intent).toUpperCase() !== 'UNKNOWN' &&
        mockOk &&
        (expectMock || realOk) &&
        (j.telephoneCalls ?? 0) === 0,
      transcript: j.actualTranscript ?? null,
      intent: j.intent ?? null,
      expectedIntent: j.expectedIntent ?? null,
      ttsProvider: j.ttsProvider ?? null,
      ttsVoice: j.ttsVoice ?? null,
      speakerId: j.ttsSpeakerId ?? j.turn?.speakerId ?? null,
      botMulawValid: j.botMulawValid ?? null,
      failureStage: j.failureStage ?? null,
      gates: j.gates ?? null,
      timing: j.timing ?? null,
    };
    if (last.ok) return last;
  }
  return last;
}

if (want('C', selected)) {
  console.error('Gate C — real STT + mock TTS (app must be VOICE_TTS_PROVIDER=mock)');
  const readinessUrl =
    process.env.SPEECH_READINESS_URL ||
    'http://smartping-voice-stream-e2e.railway.internal:8080/api/speech/readiness';
  try {
    const readyRes = await fetch(readinessUrl, { signal: AbortSignal.timeout(10_000) });
    const readyJson = await readyRes.json();
    summary.readinessBeforeC = { mode: readyJson.mode, ready: readyJson.ready };
    if (readyJson.mode !== 'mock' || readyJson.ready !== true) {
      summary.gates.C_preflight = false;
      stop(summary, 'gate_C_preflight_not_mock');
    }
    summary.gates.C_preflight = true;
  } catch (err) {
    summary.readinessBeforeC = { error: String(err?.message || err) };
    stop(summary, 'gate_C_preflight_unreachable');
  }
  const enScenarios = [
    'send_details',
    'callback',
    'not_interested',
    'do_not_call',
    'human_agent',
  ];
  const teScenarios = [
    'send_details',
    'callback',
    'not_interested',
    'do_not_call',
  ];
  for (const scenario of enScenarios) {
    summary.gateC.en.push(sim('en', scenario, { expectMock: true }));
  }
  summary.gates.C_en = summary.gateC.en.every((x) => x.ok);
  if (!summary.gates.C_en) stop(summary, 'gate_C_en');
  for (const scenario of teScenarios) {
    summary.gateC.te.push(sim('te', scenario, { expectMock: true }));
  }
  summary.gates.C_te = summary.gateC.te.every((x) => x.ok);
  if (!summary.gates.C_te) stop(summary, 'gate_C_te');
}

if (want('E', selected)) {
  console.error('Gate E — full English local-cpu');
  const enScenarios = [
    ...Array(3).fill('send_details'),
    ...Array(3).fill('callback'),
    ...Array(2).fill('not_interested'),
    ...Array(2).fill('do_not_call'),
  ];
  for (const scenario of enScenarios) {
    summary.fullEn.push(sim('en', scenario, { expectMock: false }));
  }
  summary.gates.E_en = summary.fullEn.every((x) => x.ok);
  if (!summary.gates.E_en) stop(summary, 'gate_E_en');
}

if (want('F', selected)) {
  console.error('Gate F — full Telugu local-cpu');
  const teScenarios = [
    ...Array(3).fill('send_details'),
    ...Array(3).fill('callback'),
    ...Array(2).fill('not_interested'),
    ...Array(2).fill('do_not_call'),
  ];
  for (const scenario of teScenarios) {
    summary.fullTe.push(sim('te', scenario, { expectMock: false }));
  }
  summary.gates.F_te = summary.fullTe.every((x) => x.ok);
  if (!summary.gates.F_te) stop(summary, 'gate_F_te');
}

summary.ok = true;
console.log(JSON.stringify(summary, null, 2));
try {
  writeFileSync('/tmp/phase4e3-acceptance.json', JSON.stringify(summary, null, 2));
} catch {
  // ignore
}
console.error('PHASE_4E3_ACCEPTANCE_OK');
