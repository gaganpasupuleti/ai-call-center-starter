#!/usr/bin/env node
/**
 * Prepare ephemeral speech fixture bank (serial synthesis).
 *
 * Default dir: /tmp/codequest-speech-fixtures (or SPEECH_FIXTURE_DIR / Windows TEMP).
 * Does not commit audio. Deletes after battery unless --keep-fixtures.
 *
 *   npm run prepare:speech-fixtures
 *   npm run prepare:speech-fixtures -- --synthetic-tone
 *   npm run prepare:speech-fixtures -- --keep-fixtures
 */
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  unlinkSync,
} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { validateMulawFixture } from './lib/audio-fixture-validation.mjs';
import { generateToneMulaw } from './lib/synthetic-tone-mulaw.mjs';
import { SCENARIOS } from './simulate-local-speech-conversation.mjs';

const FIXTURES = [
  { language: 'en', scenario: 'send_details', file: 'en-send-details.ulaw' },
  { language: 'en', scenario: 'callback', file: 'en-callback.ulaw' },
  { language: 'en', scenario: 'not_interested', file: 'en-not-interested.ulaw' },
  { language: 'en', scenario: 'do_not_call', file: 'en-do-not-call.ulaw' },
  { language: 'en', scenario: 'human_agent', file: 'en-human-agent.ulaw' },
  { language: 'te', scenario: 'send_details', file: 'te-send-details.ulaw' },
  { language: 'te', scenario: 'callback', file: 'te-callback.ulaw' },
  { language: 'te', scenario: 'not_interested', file: 'te-not-interested.ulaw' },
  { language: 'te', scenario: 'do_not_call', file: 'te-do-not-call.ulaw' },
];

function defaultFixtureDir() {
  if (process.env.SPEECH_FIXTURE_DIR) return process.env.SPEECH_FIXTURE_DIR;
  if (process.platform === 'win32') {
    return path.join(os.tmpdir(), 'codequest-speech-fixtures');
  }
  return '/tmp/codequest-speech-fixtures';
}

function parseArgs(argv) {
  const out = {
    dir: defaultFixtureDir(),
    keepFixtures: false,
    syntheticTone: false,
    reuse: true,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dir' && argv[i + 1]) out.dir = argv[++i];
    else if (a === '--keep-fixtures') out.keepFixtures = true;
    else if (a === '--synthetic-tone') out.syntheticTone = true;
    else if (a === '--no-reuse') out.reuse = false;
    else if (a === '--delete') {
      // explicit cleanup
      out.deleteOnly = true;
    }
  }
  return out;
}

/** Serial lock — one synthesis at a time (no concurrent fixture generation). */
export async function generateFixturesSerial(entries, { synthesizeOne }) {
  const results = [];
  for (const entry of entries) {
    // eslint-disable-next-line no-await-in-loop
    const one = await synthesizeOne(entry);
    results.push(one);
  }
  return results;
}

export function fixtureCacheKey(language, scenario) {
  return `${language}-${String(scenario).replaceAll('_', '-')}`;
}

export function loadFixtureManifest(dir) {
  const p = path.join(dir, 'manifest.json');
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8'));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.deleteOnly) {
    if (existsSync(args.dir)) rmSync(args.dir, { recursive: true, force: true });
    console.log(JSON.stringify({ ok: true, deleted: args.dir, telephoneCalls: 0 }));
    return;
  }

  mkdirSync(args.dir, { recursive: true });
  const existing = args.reuse ? loadFixtureManifest(args.dir) : null;
  const manifest = {
    createdAt: new Date().toISOString(),
    dir: args.dir,
    syntheticTone: args.syntheticTone,
    concurrent: 1,
    fixtures: [],
  };

  async function synthesizeOne(entry) {
    const outPath = path.join(args.dir, entry.file);
    const scenario = SCENARIOS[entry.language][entry.scenario];
    if (!scenario) throw new Error(`unknown scenario ${entry.scenario}`);

    if (args.reuse && existsSync(outPath) && existing?.fixtures?.some((f) => f.file === entry.file)) {
      const prior = existing.fixtures.find((f) => f.file === entry.file);
      const bytes = readFileSync(outPath);
      const validation = validateMulawFixture(bytes);
      // Invalidate reuse when scenario text changed (common after ASR fixture tweaks).
      if (validation.valid && prior?.text === scenario.text) {
        return {
          ...entry,
          text: scenario.text,
          path: outPath,
          reused: true,
          validation,
        };
      }
    }

    if (args.syntheticTone) {
      const tone = generateToneMulaw({
        durationMs: 1200 + (entry.language === 'te' ? 200 : 0),
        frequencyHz: entry.language === 'te' ? 520 : 440,
      });
      writeFileSync(outPath, tone);
    } else {
      const script = path.resolve('scripts/generate-synthetic-caller-fixture.mjs');
      const synthLanguage = scenario.fixtureSynthLanguage || entry.language;
      const result = spawnSync(
        process.execPath,
        [
          script,
          '--language',
          synthLanguage,
          '--text',
          scenario.text,
          '--out',
          outPath,
        ],
        { encoding: 'utf8', env: process.env },
      );
      if (result.status !== 0) {
        throw new Error(
          `fixture synth failed for ${entry.file}: ${result.stderr || result.stdout}`,
        );
      }
    }

    const bytes = readFileSync(outPath);
    const validation = validateMulawFixture(bytes);
    if (!validation.valid) {
      try {
        unlinkSync(outPath);
      } catch {
        // ignore
      }
      throw new Error(`fixture_invalid:${entry.file}:${validation.reason}`);
    }
    return {
      ...entry,
      text: scenario.text,
      path: outPath,
      reused: false,
      validation,
    };
  }

  const results = await generateFixturesSerial(FIXTURES, { synthesizeOne });
  for (const r of results) {
    manifest.fixtures.push({
      file: r.file,
      language: r.language,
      scenario: r.scenario,
      text: r.text,
      reused: r.reused,
      durationMs: r.validation.durationMs,
      peak: r.validation.peak,
      rms: r.validation.rms,
      dbfs: r.validation.dbfs,
      valid: r.validation.valid,
    });
  }

  writeFileSync(path.join(args.dir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  const report = {
    ok: true,
    dir: args.dir,
    count: results.length,
    concurrent: 1,
    keepFixtures: args.keepFixtures,
    syntheticTone: args.syntheticTone,
    fixtures: manifest.fixtures,
    telephoneCalls: 0,
  };
  console.log(JSON.stringify(report, null, 2));

  if (!args.keepFixtures && process.env.SPEECH_FIXTURE_AUTO_DELETE === 'true') {
    rmSync(args.dir, { recursive: true, force: true });
  }
}

const isDirect =
  process.argv[1] &&
  path.resolve(process.argv[1]).endsWith('prepare-speech-fixtures.mjs');

if (isDirect) {
  main().catch((err) => {
    console.error(JSON.stringify({ ok: false, error: err.message, telephoneCalls: 0 }));
    process.exit(1);
  });
}
