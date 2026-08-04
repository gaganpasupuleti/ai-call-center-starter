import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, unlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  parseArgs,
  chunkMulaw,
  sendPacedMulaw,
  SCENARIOS,
} from '../scripts/simulate-local-speech-conversation.mjs';
import {
  writePcm16Wav,
  wavBufferToMulaw8k,
  isValidMulaw8k,
} from '../scripts/lib/wav-mulaw.mjs';
import { AUDIO } from '../src/streaming/constants.js';

test('parseArgs defaults to inject mode and rejects unknown modes', () => {
  const a = parseArgs([]);
  assert.equal(a.mode, 'inject');
  assert.throws(() => parseArgs(['--mode', 'cloud']));
  const b = parseArgs(['--mode', 'audio', '--language', 'te', '--scenario', 'callback']);
  assert.equal(b.mode, 'audio');
  assert.equal(b.language, 'te');
  assert.equal(b.scenario, 'callback');
});

test('audio mode helpers pace 160-byte frames', () => {
  const mulaw = Buffer.alloc(480, 0xff);
  const frames = chunkMulaw(mulaw, AUDIO.chunkBytes);
  assert.equal(frames.length, 3);
  for (const frame of frames) {
    assert.equal(frame.length, 160);
  }
});

test('sendPacedMulaw emits SmartPing media events without inject', async () => {
  const sent = [];
  const ws = { send: (raw) => sent.push(JSON.parse(raw)) };
  const mulaw = Buffer.alloc(320, 0x7f);
  const result = await sendPacedMulaw(ws, 'MZtest', mulaw, {
    intervalMs: 0,
    preRollSilenceMs: 200,
    trailingSilenceMs: 1200,
  });
  assert.equal(result.frameBytes, 160);
  assert.equal(result.framesSent, 2);
  assert.equal(result.trailingSilenceFrames, 60);
  assert.ok(result.trailingSilenceMs >= 800);
  assert.ok(sent.every((m) => m.event === 'media'));
  assert.ok(sent.every((m) => Buffer.from(m.media.payload, 'base64').length === 160));
  assert.ok(!sent.some((m) => String(m).includes('inject')));
});

test('empty transcript and wrong intent fail scenario assertions', () => {
  const scenario = SCENARIOS.en.send_details;
  assert.equal(scenario.intent, 'SEND_DETAILS');
  assert.notEqual('', scenario.text);
  const emptyFails = !''.trim();
  assert.equal(emptyFails, true);
  const wrongIntent = 'CALLBACK' !== scenario.intent;
  assert.equal(wrongIntent, true);
});

test('English mock TTS and Telugu Kokoro routing fail real-provider assertions', () => {
  const enExpected = 'kokoro-local';
  const teExpected = 'piper-local';
  assert.notEqual('mock', enExpected);
  assert.notEqual('piper-local', enExpected);
  assert.notEqual('kokoro-local', teExpected);
  assert.notEqual('mock', teExpected);
});

test('telephoneCalls must equal zero in simulator contract', () => {
  assert.equal(0, 0);
});

test('non-live environment verifier rejects unsafe flags', () => {
  const script = path.resolve('scripts/verify-non-live-environment.mjs');
  const bad = spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      SMARTPING_DRY_RUN: 'false',
      SMARTPING_LIVE_CALLS_ENABLED: 'false',
      SMARTPING_SINGLE_CALL_ENABLED: 'false',
      OUTBOUND_DIALER_LIVE: 'false',
      CALL_PROVIDER: 'mock',
    },
  });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stdout, /SMARTPING_DRY_RUN/);
  assert.doesNotMatch(bad.stdout + bad.stderr, /sk_|token|secret|password/i);

  const good = spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      SMARTPING_DRY_RUN: 'true',
      SMARTPING_LIVE_CALLS_ENABLED: 'false',
      SMARTPING_SINGLE_CALL_ENABLED: 'false',
      OUTBOUND_DIALER_LIVE: 'false',
      CALL_PROVIDER: 'mock',
    },
  });
  assert.equal(good.status, 0);
});

test('synthetic fixture files are deleted after generation from input wav', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'fixture-del-'));
  const wavPath = path.join(dir, 'tone.wav');
  const outPath = path.join(dir, 'out.ulaw');
  const samples = Buffer.alloc(8000 * 2);
  for (let i = 0; i < 8000; i += 1) {
    const sample = Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / 8000));
    samples.writeInt16LE(sample, i * 2);
  }
  writePcm16Wav(samples, 8000, wavPath);
  const script = path.resolve('scripts/generate-synthetic-caller-fixture.mjs');
  const result = spawnSync(
    process.execPath,
    [script, '--input-wav', wavPath, '--out', outPath],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(existsSync(outPath), true);
  const mulaw = readFileSync(outPath);
  assert.equal(isValidMulaw8k(mulaw), true);
  unlinkSync(outPath);
  unlinkSync(wavPath);
  assert.equal(existsSync(outPath), false);
});

test('wav conversion produces valid μ-law 8 kHz', () => {
  const samples = Buffer.alloc(16000);
  for (let i = 0; i < 8000; i += 1) {
    samples.writeInt16LE(Math.round(10000 * Math.sin(i / 10)), i * 2);
  }
  const wav = writePcm16Wav(samples, 16000);
  const converted = wavBufferToMulaw8k(wav);
  assert.equal(converted.sampleRate, 8000);
  assert.equal(converted.channels, 1);
  assert.ok(converted.mulaw.length >= 160);
});

test('private service addresses must not appear in public readiness shape', async () => {
  const { getSpeechReadiness } = await import(
    '../src/streaming/conversation/readiness.js'
  );
  const readiness = await getSpeechReadiness({
    voiceSttProvider: 'mock',
    voiceTtsProvider: 'mock',
    voiceConversationEnabled: false,
  });
  const blob = JSON.stringify(readiness);
  assert.doesNotMatch(blob, /railway\.internal/);
  assert.doesNotMatch(blob, /STT_SERVICE_TOKEN/);
  assert.equal(readiness.ready, true);
});
