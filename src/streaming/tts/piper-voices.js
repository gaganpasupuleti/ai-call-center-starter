/**
 * Approved Piper voices (Telugu + English CPU runtime).
 */
import { TtsProviderError, TTS_ERROR_CODES } from './errors.js';

export const PIPER_TELUGU_VOICES = Object.freeze([
  'te_IN-padmavathi-medium',
  'te_IN-venkatesh-medium',
]);

export const PIPER_ENGLISH_VOICES = Object.freeze([
  'en_US-libritts_r-medium',
]);

export const PIPER_ALLOWED_VOICES = Object.freeze([
  ...PIPER_TELUGU_VOICES,
  ...PIPER_ENGLISH_VOICES,
]);

export const PIPER_DEFAULT_VOICE = 'te_IN-padmavathi-medium';
export const PIPER_DEFAULT_ENGLISH_VOICE = 'en_US-libritts_r-medium';
export const PIPER_DEFAULT_ENGLISH_SPEAKER_ID = 0;

/** Multi-speaker English model: speaker ids are 0 .. numSpeakers-1 */
export const PIPER_ENGLISH_SPEAKER_COUNT = Object.freeze({
  'en_US-libritts_r-medium': 904,
});

const ALLOWED = new Set(PIPER_ALLOWED_VOICES);
const ENGLISH = new Set(PIPER_ENGLISH_VOICES);
const TELUGU = new Set(PIPER_TELUGU_VOICES);

export function isAllowedPiperVoice(voice) {
  return ALLOWED.has(String(voice || '').trim());
}

export function isEnglishPiperVoice(voice) {
  return ENGLISH.has(String(voice || '').trim());
}

export function isTeluguPiperVoice(voice) {
  return TELUGU.has(String(voice || '').trim());
}

export function validatePiperVoice(voice, { language = null } = {}) {
  const id = String(voice || '').trim();
  if (!ALLOWED.has(id)) {
    throw new TtsProviderError(
      TTS_ERROR_CODES.PIPER_VOICE_NOT_ALLOWED,
      'Voice is not in the Piper allowlist',
      { statusCode: 400 },
    );
  }
  if (language === 'en' && !ENGLISH.has(id)) {
    throw new TtsProviderError(
      TTS_ERROR_CODES.LANGUAGE_VOICE_MISMATCH,
      'Telugu Piper voice cannot be used with English text',
      { statusCode: 400 },
    );
  }
  if (language === 'te' && !TELUGU.has(id)) {
    throw new TtsProviderError(
      TTS_ERROR_CODES.LANGUAGE_VOICE_MISMATCH,
      'English Piper voice cannot be used with Telugu text',
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
 * Validate speaker_id for multi-speaker Piper voices.
 * Single-speaker voices must not receive a speaker id.
 */
export function validatePiperSpeakerId(voice, speakerId, { numSpeakers } = {}) {
  const id = String(voice || '').trim();
  const multi =
    numSpeakers ??
    PIPER_ENGLISH_SPEAKER_COUNT[id] ??
    (isEnglishPiperVoice(id) ? 904 : 1);

  if (speakerId == null || speakerId === '') {
    if (multi > 1) return 0;
    return null;
  }

  const n = Number(speakerId);
  if (!Number.isInteger(n) || n < 0) {
    throw new TtsProviderError(
      TTS_ERROR_CODES.PIPER_SPEAKER_NOT_ALLOWED,
      'Piper speaker ID must be a non-negative integer',
      { statusCode: 400 },
    );
  }

  if (multi <= 1) {
    throw new TtsProviderError(
      TTS_ERROR_CODES.PIPER_SPEAKER_NOT_ALLOWED,
      'Speaker ID cannot be used with a single-speaker Piper voice',
      { statusCode: 400 },
    );
  }

  if (n >= multi) {
    throw new TtsProviderError(
      TTS_ERROR_CODES.PIPER_SPEAKER_NOT_ALLOWED,
      `Piper speaker ID ${n} is outside range 0..${multi - 1}`,
      { statusCode: 400 },
    );
  }

  return n;
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

export function defaultPiperVoiceForLanguage(language) {
  return language === 'en' ? PIPER_DEFAULT_ENGLISH_VOICE : PIPER_DEFAULT_VOICE;
}
