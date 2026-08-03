#!/usr/bin/env node
/**
 * Phase 4E.1 real-audio battery (runs inside Railway private network).
 * Never places telephone calls. Never contacts SmartPing.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const EN = ['send_details', 'callback', 'not_interested', 'do_not_call', 'human_agent'];
const TE = ['send_details', 'callback', 'not_interested', 'do_not_call'];

function envTarget() {
  return (
    process.env.SMARTPING_STREAM_URL ||
    process.env.AUDIO_SIM_TARGET ||
    'ws://smartping-voice-stream-e2e.railway.internal:8080/ws/voice/smartping'
  );
}

function runOne({ language, scenario, mode = 'audio' }) {
  const script = path.join(root, 'scripts/simulate-local-speech-conversation.mjs');
  const args = [
    script,
    '--mode',
    mode,
    '--language',
    language,
    '--scenario',
    scenario,
    '--target',
    envTarget(),
    '--timeout-ms',
    String(process.env.AUDIO_SIM_TIMEOUT_MS || 120000),
  ];
  const started = Date.now();
  const result = spawnSync(process.execPath, args, {
    encoding: 'utf8',
    env: process.env,
    cwd: root,
    timeout: Number(process.env.AUDIO_SIM_TIMEOUT_MS || 120000) + 30_000,
  });
  console.error(
    `done ${language}/${scenario} exit=${result.status} bytes=${(result.stdout || '').length}`,
  );
  let report = null;
  try {
    report = JSON.parse(result.stdout || '{}');
  } catch {
    report = { ok: false, parseError: true, stdout: (result.stdout || '').slice(0, 500) };
  }
  return {
    language,
    scenario,
    mode,
    exitCode: result.status,
    durationMs: Date.now() - started,
    report,
    stderrTail: String(result.stderr || '').split('\n').slice(-5).join('\n'),
  };
}

function summarize(latencies) {
  if (!latencies.length) return { count: 0, min: null, median: null, p95: null, max: null };
  const sorted = [...latencies].sort((a, b) => a - b);
  const pct = (p) =>
    sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
  return {
    count: sorted.length,
    min: sorted[0],
    median: pct(50),
    p95: pct(95),
    max: sorted[sorted.length - 1],
  };
}

function main() {
  const results = [];
  console.error('PHASE_4E1_AUDIO_BATTERY_START target=' + envTarget());

  for (const scenario of EN) {
    console.error(`EN ${scenario}`);
    results.push(runOne({ language: 'en', scenario }));
  }
  for (const scenario of TE) {
    console.error(`TE ${scenario}`);
    results.push(runOne({ language: 'te', scenario }));
  }

  // Latency loops (warm after scenarios)
  const enLatency = [];
  const teLatency = [];
  for (let i = 0; i < 10; i += 1) {
    console.error(`EN latency ${i + 1}/10`);
    const r = runOne({ language: 'en', scenario: 'send_details' });
    results.push({ ...r, latencySample: true, cold: false });
    if (r.report?.ok) enLatency.push(r.durationMs);
  }
  for (let i = 0; i < 10; i += 1) {
    console.error(`TE latency ${i + 1}/10`);
    const r = runOne({ language: 'te', scenario: 'callback' });
    results.push({ ...r, latencySample: true, cold: false });
    if (r.report?.ok) teLatency.push(r.durationMs);
  }

  const summary = {
    ok: results.every((r) => r.report?.ok && r.report?.telephoneCalls === 0),
    telephoneCalls: 0,
    scenarioResults: results.filter((r) => !r.latencySample).map((r) => ({
      language: r.language,
      scenario: r.scenario,
      ok: Boolean(r.report?.ok),
      intent: r.report?.intent,
      expectedIntent: r.report?.expectedIntent,
      transcript: r.report?.actualTranscript,
      ttsProvider: r.report?.ttsProvider,
      ttsVoice: r.report?.ttsVoice,
      usedTranscriptInject: r.report?.usedTranscriptInject,
      botMulawValid: r.report?.botMulawValid,
      durationMs: r.durationMs,
    })),
    englishLatencyMs: summarize(enLatency),
    teluguLatencyMs: summarize(teLatency),
    failureCount: results.filter((r) => !r.report?.ok).length,
  };

  console.error(JSON.stringify(summary));
  console.log(JSON.stringify(summary, null, 2));
  try {
    writeFileSync('/tmp/phase4e1-audio-battery.json', JSON.stringify(summary, null, 2));
    console.error('WROTE /tmp/phase4e1-audio-battery.json');
  } catch (err) {
    console.error('WRITE_RESULTS_FAILED ' + err.message);
  }
  if (!summary.ok) process.exit(1);
  console.error('PHASE_4E1_AUDIO_BATTERY_OK');
}

main();
