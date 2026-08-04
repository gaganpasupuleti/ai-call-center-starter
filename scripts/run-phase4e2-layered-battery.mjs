#!/usr/bin/env node
/**
 * Phase 4E.2 layered acceptance battery (private network).
 * Gates A→F. Stops on first gate failure. Never places telephone calls.
 *
 * PHASE4E2_START_GATE=A|B|D|E|F to resume after a prior green gate
 * (fixtures must still exist under SPEECH_FIXTURE_DIR).
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const fixtureDir =
  process.env.SPEECH_FIXTURE_DIR || '/tmp/codequest-speech-fixtures';

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, {
    encoding: 'utf8',
    cwd: root,
    env: process.env,
    timeout: opts.timeout ?? 180_000,
    maxBuffer: 20 * 1024 * 1024,
  });
  let json = null;
  const out = String(result.stdout || '');
  // Find the last complete top-level JSON object by scanning for matching braces.
  let parsed = null;
  for (let i = out.length - 1; i >= 0; i -= 1) {
    if (out[i] !== '}') continue;
    // walk backward for matching '{'
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
  if (parsed) {
    json = parsed;
  } else {
    json = {
      ok: false,
      parseError: true,
      signal: result.signal,
      status: result.status,
      stdoutHead: out.slice(0, 600),
      stderrHead: String(result.stderr || '').slice(0, 600),
    };
  }
  return { status: result.status, json, stderr: result.stderr, signal: result.signal, stdout: out };
}

function stop(summary, reason) {
  summary.ok = false;
  summary.stoppedAt = reason;
  console.log(JSON.stringify(summary, null, 2));
  try {
    writeFileSync('/tmp/phase4e2-layered-battery.json', JSON.stringify(summary, null, 2));
  } catch {
    // ignore
  }
  process.exit(1);
}

const startGate = String(process.env.PHASE4E2_START_GATE || 'A').toUpperCase();
const order = ['A', 'B', 'D', 'E', 'F'];
function shouldRun(gate) {
  return order.indexOf(gate) >= order.indexOf(startGate);
}

const summary = {
  ok: true,
  telephoneCalls: 0,
  startGate,
  gates: {},
  directStt: { en: [], te: [] },
  kokoro: null,
  piper: null,
  appMockTts: [],
  fullEn: [],
  fullTe: [],
};

if (shouldRun('A')) {
  console.error('Gate A — prepare + validate fixtures (serial)');
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
  summary.gates.A_fixtures = prep.json?.ok === true;
  summary.gateA = {
    ok: prep.json?.ok === true,
    status: prep.status,
    signal: prep.signal,
    error: prep.json?.error || null,
    stderrTail: String(prep.stderr || '').slice(-800),
    stdoutHead: String(prep.json?.stdoutHead || prep.json?.parseError ? JSON.stringify(prep.json).slice(0, 500) : ''),
    count: prep.json?.count ?? null,
    parseError: prep.json?.parseError === true,
  };
  if (!summary.gates.A_fixtures) stop(summary, 'gate_A_fixtures');
} else {
  summary.gates.A_fixtures = 'skipped';
}

if (shouldRun('B')) {
  console.error('Gate B — direct STT EN/TE (5 each)');
  const enFiles = [
    'en-send-details.ulaw',
    'en-callback.ulaw',
    'en-not-interested.ulaw',
    'en-do-not-call.ulaw',
    'en-human-agent.ulaw',
  ];
  const teFiles = [
    'te-send-details.ulaw',
    'te-callback.ulaw',
    'te-not-interested.ulaw',
    'te-do-not-call.ulaw',
    'te-send-details.ulaw',
  ];
  for (const file of enFiles) {
    const r = run(process.execPath, [
      path.join(root, 'scripts/test-stt-stream-real-audio.mjs'),
      '--language',
      'en',
      '--fixture-ulaw',
      path.join(fixtureDir, file),
    ]);
    summary.directStt.en.push({
      file,
      ok: r.json?.ok === true,
      code: r.json?.code,
      finalizeReason: r.json?.finalizeReason,
    });
  }
  for (const file of teFiles) {
    const r = run(process.execPath, [
      path.join(root, 'scripts/test-stt-stream-real-audio.mjs'),
      '--language',
      'te',
      '--fixture-ulaw',
      path.join(fixtureDir, file),
    ]);
    summary.directStt.te.push({
      file,
      ok: r.json?.ok === true,
      code: r.json?.code,
      finalizeReason: r.json?.finalizeReason,
    });
  }
  summary.gates.B_directStt =
    summary.directStt.en.every((x) => x.ok) && summary.directStt.te.every((x) => x.ok);
  if (!summary.gates.B_directStt) stop(summary, 'gate_B_direct_stt');
} else {
  summary.gates.B_directStt = 'skipped';
}

if (shouldRun('D')) {
  console.error('Gate D — Kokoro concurrency 1 then 2');
  const k1 = run(
    process.execPath,
    [
      path.join(root, 'scripts/test-kokoro-stability.mjs'),
      '--requests',
      String(process.env.KOKORO_STABILITY_REQUESTS || 20),
      '--concurrency',
      '1',
    ],
    { timeout: 45 * 60_000 },
  );
  summary.kokoro = {
    concurrency1: k1.json,
    concurrency1Status: k1.status,
    concurrency1Stderr: String(k1.stderr || '').slice(-400),
  };
  summary.gates.D_kokoro_c1 = k1.json?.ok === true;
  if (!summary.gates.D_kokoro_c1) stop(summary, 'gate_D_kokoro_c1');
  const k2 = run(
    process.execPath,
    [
      path.join(root, 'scripts/test-kokoro-stability.mjs'),
      '--requests',
      '10',
      '--concurrency',
      '2',
    ],
    { timeout: 30 * 60_000 },
  );
  summary.kokoro.concurrency2 = k2.json;
  summary.gates.D_kokoro_c2 = k2.json?.ok === true;
} else {
  summary.gates.D_kokoro_c1 = 'skipped';
  summary.gates.D_kokoro_c2 = 'skipped';
}

const target =
  process.env.SMARTPING_STREAM_URL ||
  process.env.AUDIO_SIM_TARGET ||
  'ws://smartping-voice-stream-e2e.railway.internal:8080/ws/voice/smartping';

function sim(language, scenario) {
  return run(
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
      path.join(
        fixtureDir,
        `${language === 'te' ? 'te' : 'en'}-${scenario.replaceAll('_', '-')}.ulaw`,
      ),
      '--target',
      target,
      '--timeout-ms',
      String(process.env.AUDIO_SIM_TIMEOUT_MS || 120000),
    ],
    { timeout: 180_000 },
  );
}

if (shouldRun('E')) {
  console.error('Gate E — full English turns');
  const enScenarios = [
    ...Array(3).fill('send_details'),
    ...Array(3).fill('callback'),
    ...Array(2).fill('not_interested'),
    ...Array(2).fill('do_not_call'),
  ];
  for (const scenario of enScenarios) {
    const r = sim('en', scenario);
    summary.fullEn.push({
      scenario,
      ok: r.json?.ok === true,
      transcript: r.json?.actualTranscript ?? null,
      intent: r.json?.intent ?? null,
      ttsProvider: r.json?.ttsProvider ?? null,
      failureStage: r.json?.failureStage ?? null,
    });
  }
  summary.gates.E_fullEn = summary.fullEn.every((x) => x.ok);
  if (!summary.gates.E_fullEn) stop(summary, 'gate_E_full_en');
} else {
  summary.gates.E_fullEn = 'skipped';
}

if (shouldRun('F')) {
  console.error('Gate F — full Telugu turns');
  const teScenarios = [
    ...Array(3).fill('send_details'),
    ...Array(3).fill('callback'),
    ...Array(2).fill('not_interested'),
    ...Array(2).fill('do_not_call'),
  ];
  for (const scenario of teScenarios) {
    const r = sim('te', scenario);
    summary.fullTe.push({
      scenario,
      ok: r.json?.ok === true,
      transcript: r.json?.actualTranscript ?? null,
      intent: r.json?.intent ?? null,
      ttsProvider: r.json?.ttsProvider ?? null,
      failureStage: r.json?.failureStage ?? null,
    });
  }
  summary.gates.F_fullTe = summary.fullTe.every((x) => x.ok);
  if (!summary.gates.F_fullTe) stop(summary, 'gate_F_full_te');
} else {
  summary.gates.F_fullTe = 'skipped';
}

summary.ok = true;
console.log(JSON.stringify(summary, null, 2));
try {
  writeFileSync('/tmp/phase4e2-layered-battery.json', JSON.stringify(summary, null, 2));
} catch {
  // ignore
}
console.error('PHASE_4E2_LAYERED_BATTERY_OK');
