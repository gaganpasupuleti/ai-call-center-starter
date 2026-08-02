import { TtsProviderError, TTS_ERROR_CODES } from './errors.js';

/** Configuration-driven Kokoro English voice allowlist (Phase 4C). */

export const KOKORO_ALLOWED_VOICES = Object.freeze([
  'af_bella',
  'af_sky',
  'af_nicole',
  'af_sarah',
  'am_michael',
  'am_adam',
  'bf_emma',
  'bf_isabella',
  'bm_george',
]);

export const KOKORO_DEFAULT_VOICE = 'af_bella';

const ALLOWED = new Set(KOKORO_ALLOWED_VOICES);

export function isAllowedKokoroVoice(voice) {
  return ALLOWED.has(String(voice || '').trim());
}

export function assertAllowedKokoroVoice(voice, fallback = KOKORO_DEFAULT_VOICE) {
  const id = String(voice || '').trim();
  if (ALLOWED.has(id)) return id;
  if (fallback && ALLOWED.has(fallback)) return fallback;
  return KOKORO_DEFAULT_VOICE;
}

export function validateKokoroVoice(voice) {
  const id = String(voice || '').trim();
  if (!ALLOWED.has(id)) {
    throw new TtsProviderError(
      TTS_ERROR_CODES.VOICE_NOT_ALLOWED,
      'Voice is not in the configured allowlist',
      { statusCode: 400 },
    );
  }
  return id;
}

export function filterRemoteVoices(remoteList = []) {
  const names = Array.isArray(remoteList)
    ? remoteList
        .map((v) => (typeof v === 'string' ? v : v?.id || v?.name))
        .filter(Boolean)
    : [];
  return KOKORO_ALLOWED_VOICES.filter(
    (id) => names.length === 0 || names.includes(id),
  );
}
