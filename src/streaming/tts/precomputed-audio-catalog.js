/**
 * Precomputed deterministic response μ-law catalog (Phase 4E.3).
 * Never stores customer audio — bot response templates only.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { TextToSpeechProvider } from '../ai/interfaces.js';
import { AUDIO } from '../constants.js';

export function normalizeCatalogText(text) {
  return String(text || '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

export function catalogTextHash(text) {
  return createHash('sha256').update(normalizeCatalogText(text)).digest('hex');
}

export function buildCatalogKey({
  language,
  templateId,
  textHash,
  voice,
  speed = 1,
  formatVersion = 1,
}) {
  return [
    language,
    templateId,
    textHash,
    voice,
    Number(speed).toFixed(3),
    `v${formatVersion}`,
  ].join(':');
}

export function loadPrecomputedCatalog(config = {}) {
  const enabled =
    config.precomputedAudio?.enabled === true ||
    String(process.env.PRECOMPUTED_AUDIO_ENABLED || '').toLowerCase() === 'true';
  if (!enabled) {
    return { enabled: false, ready: false, items: new Map(), reason: 'disabled' };
  }
  const manifestPath =
    config.precomputedAudio?.manifestPath ||
    process.env.PRECOMPUTED_AUDIO_MANIFEST ||
    path.join(
      config.precomputedAudio?.dir ||
        process.env.PRECOMPUTED_AUDIO_DIR ||
        '/response-audio',
      'manifest.json',
    );
  if (!existsSync(manifestPath)) {
    return {
      enabled: true,
      ready: false,
      items: new Map(),
      reason: 'manifest_missing',
      manifestPath,
    };
  }
  try {
    const raw = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const dir = path.dirname(manifestPath);
    const items = new Map();
    for (const [key, entry] of Object.entries(raw.items || {})) {
      items.set(key, { ...entry, absPath: path.join(dir, entry.file) });
    }
    return {
      enabled: true,
      ready: items.size > 0,
      version: raw.version || 1,
      format: raw.format || null,
      items,
      manifestPath,
      reason: null,
    };
  } catch (err) {
    return {
      enabled: true,
      ready: false,
      items: new Map(),
      reason: 'manifest_invalid',
      error: err.message,
    };
  }
}

export function lookupCatalogEntry(catalog, {
  language,
  templateId,
  text,
  voice,
  speed = 1,
}) {
  if (!catalog?.enabled || !catalog.ready) return null;
  const textHash = catalogTextHash(text);
  const key = buildCatalogKey({
    language,
    templateId: templateId || 'unknown',
    textHash,
    voice,
    speed,
  });
  // Also try simpler keys used by builders: `${language}:${templateId}`
  const simple = `${language}:${templateId}`;
  const entry = catalog.items.get(key) || catalog.items.get(simple);
  if (!entry) return null;
  if (entry.textHash && entry.textHash !== textHash) {
    return { rejected: true, reason: 'text_hash_mismatch' };
  }
  return entry;
}

export function createPrecomputedCatalogProvider({
  catalog,
  fallback,
  language = 'en',
} = {}) {
  return new (class PrecomputedCatalogTts extends TextToSpeechProvider {
    async synthesize(input = {}) {
      const lang = input.language || language;
      const templateId = input.metadata?.templateId || input.templateId;
      const voice = input.voice;
      const entry = lookupCatalogEntry(catalog, {
        language: lang,
        templateId,
        text: input.text,
        voice,
        speed: input.speed ?? 1,
      });
      if (entry?.rejected) {
        // Fall through to Piper — do not play stale audio
      } else if (entry?.absPath && existsSync(entry.absPath)) {
        const audio = readFileSync(entry.absPath);
        if (audio.length >= 160) {
          return {
            audio,
            format: {
              encoding: 'mulaw',
              sampleRate: AUDIO.sampleRate,
              channels: 1,
            },
            provider: 'precomputed-local',
            voice: entry.voice || voice,
            language: lang,
            durationSeconds: Number(
              (entry.durationMs != null
                ? entry.durationMs / 1000
                : audio.length / AUDIO.sampleRate
              ).toFixed(3),
            ),
            synthesisDurationMs: 0,
            cached: true,
            catalogHit: true,
          };
        }
      }
      if (!fallback) {
        throw new Error('precomputed_catalog_miss_no_fallback');
      }
      const result = await fallback.synthesize(input);
      return { ...result, catalogHit: false };
    }
  })();
}
