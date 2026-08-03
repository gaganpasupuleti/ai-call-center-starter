import { TtsProviderError, TTS_ERROR_CODES } from './errors.js';

/** Approved Piper Telugu voices (Phase 4D). */

export const PIPER_ALLOWED_VOICES = Object.freeze([
  'te_IN-padmavathi-medium',
  'te_IN-venkatesh-medium',
]);

export const PIPER_DEFAULT_VOICE = 'te_IN-padmavathi-medium';

const ALLOWED = new Set(PIPER_ALLOWED_VOICES);

export function isAllowedPiperVoice(voice) {
  return ALLOWED.has(String(voice || '').trim());
}

export function validatePiperVoice(voice) {
  const id = String(voice || '').trim();
  if (!ALLOWED.has(id)) {
    throw new TtsProviderError(
      TTS_ERROR_CODES.PIPER_VOICE_NOT_ALLOWED,
      'Voice is not in the Piper Telugu allowlist',
      { statusCode: 400 },
    );
  }
  return id;
}

export function assertAllowedPiperVoice(voice, fallback = PIPER_DEFAULT_VOICE) {
  const id = String(voice || '').trim();
  if (ALLOWED.has(id)) return id;
  if (fallback && ALLOWED.has(fallback)) return fallback;
  return PIPER_DEFAULT_VOICE;
}

/**
 * Map application speed (1.0 = normal) to Piper length_scale.
 * length_scale = 1 / speed, clamped to a safe range.
 */
export function speedToLengthScale(
  speed,
  { minSpeed = 0.75, maxSpeed = 1.25, minLengthScale = 0.8, maxLengthScale = 1.33 } = {},
) {
  const n = Number(speed);
  const clampedSpeed = Number.isFinite(n)
    ? Math.min(maxSpeed, Math.max(minSpeed, n))
    : 1.0;
  const raw = 1 / clampedSpeed;
  return Number(
    Math.min(maxLengthScale, Math.max(minLengthScale, raw)).toFixed(4),
  );
}

export function parseAllowedVoicesEnv(value, fallback = PIPER_ALLOWED_VOICES) {
  if (!value || !String(value).trim()) return [...fallback];
  const list = String(value)
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean)
    .filter((v) => ALLOWED.has(v));
  return list.length ? list : [...fallback];
}
