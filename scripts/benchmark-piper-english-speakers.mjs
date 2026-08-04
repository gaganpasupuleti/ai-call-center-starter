#!/usr/bin/env node
/**
 * Bounded English Piper multi-speaker probe (does not synthesize all 904).
 *
 *   node scripts/benchmark-piper-english-speakers.mjs
 *   node scripts/benchmark-piper-english-speakers.mjs --out-dir ./artifacts/piper-speakers
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PiperTextToSpeech } from '../src/streaming/tts/piper-client.js';
import { PIPER_DEFAULT_ENGLISH_VOICE } from '../src/streaming/tts/piper-voices.js';
import { validateMulawFixture as validateAudio } from './lib/audio-fixture-validation.mjs';
import { AUDIO } from '../src/streaming/constants.js';

const CANDIDATES = [0, 25, 50, 100, 200];
const SENTENCES = [
  'Hello, this is Code Quest.',
  'We provide training in Python and Data Analytics.',
  'Would you like to receive the course details?',
  'We can schedule a free demo session.',
  'Thank you for your time.',
];

function parseArgs(argv) {
  const out = { outDir: null, speakers: CANDIDATES };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out-dir' && argv[i + 1]) out.outDir = argv[++i];
    else if (argv[i] === '--speakers' && argv[i + 1]) {
      out.speakers = argv[++i].split(',').map((x) => Number(x.trim()));
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const baseUrl = (process.env.PIPER_BASE_URL || 'http://127.0.0.1:5000').replace(
    /\/+$/,
    '',
  );
  const voice = process.env.PIPER_ENGLISH_VOICE || PIPER_DEFAULT_ENGLISH_VOICE;
  const tts = new PiperTextToSpeech({
    baseUrl,
    defaultEnglishVoice: voice,
    cacheEnabled: false,
    retryOnce: false,
    requestTimeoutMs: Number(process.env.TTS_REQUEST_TIMEOUT_MS || 10_000),
  });

  if (args.outDir) mkdirSync(args.outDir, { recursive: true });

  const rows = [];
  for (const speakerId of args.speakers) {
    const perSpeaker = {
      speakerId,
      success: true,
      synthesisMs: [],
      wavApproxMs: [],
      peak: [],
      rms: [],
      clipped: false,
      empty: false,
      errors: [],
    };
    for (let i = 0; i < SENTENCES.length; i += 1) {
      const text = SENTENCES[i];
      const started = Date.now();
      try {
        const result = await tts.synthesize({
          text,
          language: 'en',
          voice,
          speakerId,
        });
        const ms = Date.now() - started;
        perSpeaker.synthesisMs.push(ms);
        if (!result.audio?.length) {
          perSpeaker.empty = true;
          perSpeaker.success = false;
          continue;
        }
        const durationMs = Math.round(
          (result.audio.length / AUDIO.sampleRate) * 1000,
        );
        perSpeaker.wavApproxMs.push(durationMs);
        const stats = validateAudio(result.audio, {
          minDurationMs: 200,
          maxDurationMs: 15000,
        });
        if (!stats.valid) {
          perSpeaker.success = false;
          perSpeaker.errors.push(stats.reason);
          if (stats.reason === 'clipped') perSpeaker.clipped = true;
        } else {
          perSpeaker.peak.push(stats.peak);
          perSpeaker.rms.push(stats.rms);
        }
        if (args.outDir) {
          writeFileSync(
            path.join(args.outDir, `speaker-${speakerId}-${i}.ulaw`),
            result.audio,
          );
        }
      } catch (err) {
        perSpeaker.success = false;
        perSpeaker.errors.push(err.code || err.message);
      }
    }
    const avg = (arr) =>
      arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : null;
    rows.push({
      speakerId,
      success: perSpeaker.success && !perSpeaker.empty && !perSpeaker.clipped,
      avgSynthesisMs: avg(perSpeaker.synthesisMs),
      avgDurationMs: avg(perSpeaker.wavApproxMs),
      avgPeak: perSpeaker.peak.length
        ? Number(
            (
              perSpeaker.peak.reduce((a, b) => a + b, 0) / perSpeaker.peak.length
            ).toFixed(3),
          )
        : null,
      avgRms: perSpeaker.rms.length
        ? Number(
            (
              perSpeaker.rms.reduce((a, b) => a + b, 0) / perSpeaker.rms.length
            ).toFixed(3),
          )
        : null,
      clipped: perSpeaker.clipped,
      empty: perSpeaker.empty,
      errors: perSpeaker.errors.slice(0, 5),
    });
  }

  // Prefer successful speakers with mid RMS (not quiet, not clipped) and stable duration.
  const viable = rows.filter((r) => r.success);
  let selected = viable[0] || null;
  if (viable.length) {
    selected = [...viable].sort((a, b) => {
      const aScore = Math.abs((a.avgRms || 0) - 0.12) + (a.avgSynthesisMs || 0) / 10000;
      const bScore = Math.abs((b.avgRms || 0) - 0.12) + (b.avgSynthesisMs || 0) / 10000;
      return aScore - bScore;
    })[0];
  }

  const report = {
    ok: Boolean(selected),
    voice,
    candidates: rows,
    selectedSpeakerId: selected?.speakerId ?? null,
    selectionReason: selected
      ? 'Automated pick: successful synthesis, no clipping, mid RMS, lower synthesis time among candidates. Not a human listening approval.'
      : 'No viable speaker among candidates',
    telephoneCalls: 0,
    note: 'Human listening approval was not performed in this automated run.',
  };
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exit(1);
}

main().catch((err) => {
  console.error(JSON.stringify({ ok: false, error: err.message }));
  process.exit(1);
});
