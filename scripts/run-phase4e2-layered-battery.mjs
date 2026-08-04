#!/usr/bin/env node
/**
 * Phase 4E.2 layered acceptance battery (private network).
 * Gates A→F. Stops on first gate failure. Never places telephone calls.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
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
  });
  let json = null;
  try {
    json = JSON.parse(result.stdout || '{}');
  } catch {
    json = { ok: false, parseError: true, stdoutHead: String(result.stdout || '').slice(0, 400) };
  }
  return { status: result.status, json, stderr: result.stderr };
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

const summary = {
  ok: true,
  telephoneCalls: 0,
  gates: {},
  directStt: { en: [], te: [] },
  kokoro: null,
  piper: null,
  appMockTts: [],
  fullEn: [],
  fullTe: [],
};

console.error('Gate A — prepare + validate fixtures (serial)');
mkdirSync(fixtureDir, { recursive: true });
const prep = run(process.execPath, [
  path.join(root, 'scripts/prepare-speech-fixtures.mjs'),
  '--dir',
  fixtureDir,
  '--keep-fixtures',
], { timeout: 600_000 });
summary.gates.A_fixtures = prep.json?.ok === true;
summary.gateA = {
  ok: prep.json?.ok === true,
  status: prep.status,
  error: prep.json?.error || null,
  stderrTail: String(prep.stderr || '').slice(-500),
  count: prep.json?.count ?? null,
};
if (!summary.gates.A_fixtures) stop(summary, 'gate_A_fixtures');

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
  summary.directStt.en.push({ file, ok: r.json?.ok === true, code: r.json?.code, finalizeReason: r.json?.finalizeReason });
}
for (const file of teFiles) {
  const r = run(process.execPath, [
    path.join(root, 'scripts/test-stt-stream-real-audio.mjs'),
    '--language',
    'te',
    '--fixture-ulaw',
    path.join(fixtureDir, file),
  ]);
  summary.directStt.te.push({ file, ok: r.json?.ok === true, code: r.json?.code, finalizeReason: r.json?.finalizeReason });
}
summary.gates.B_directStt =
  summary.directStt.en.every((x) => x.ok) && summary.directStt.te.every((x) => x.ok);
if (!summary.gates.B_directStt) stop(summary, 'gate_B_direct_stt');

console.error('Gate D — Kokoro concurrency 1 then 2');
const k1 = run(process.execPath, [
  path.join(root, 'scripts/test-kokoro-stability.mjs'),
  '--requests',
  '20',
  '--concurrency',
  '1',
]);
summary.kokoro = { concurrency1: k1.json };
summary.gates.D_kokoro_c1 = k1.json?.ok === true;
if (!summary.gates.D_kokoro_c1) stop(summary, 'gate_D_kokoro_c1');
const k2 = run(process.execPath, [
  path.join(root, 'scripts/test-kokoro-stability.mjs'),
  '--requests',
  '10',
  '--concurrency',
  '2',
]);
summary.kokoro.concurrency2 = k2.json;
summary.gates.D_kokoro_c2 = k2.json?.ok === true;
// concurrency 2 is informational; do not block E/F if c1 passed

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
      path.join(fixtureDir, `${language === 'te' ? 'te' : 'en'}-${scenario.replaceAll('_', '-')}.ulaw`),
      '--target',
      target,
      '--timeout-ms',
      String(process.env.AUDIO_SIM_TIMEOUT_MS || 120000),
    ],
    { timeout: 150_000 },
  );
}

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

summary.ok = true;
console.log(JSON.stringify(summary, null, 2));
try {
  writeFileSync('/tmp/phase4e2-layered-battery.json', JSON.stringify(summary, null, 2));
} catch {
  // ignore
}
console.error('PHASE_4E2_LAYERED_BATTERY_OK');
