import { TextToSpeechProvider } from '../ai/interfaces.js';
import { TtsProviderError, TTS_ERROR_CODES } from './errors.js';
import { isAllowedKokoroVoice } from './kokoro-voices.js';
import {
  isAllowedPiperVoice,
  isEnglishPiperVoice,
  isTeluguPiperVoice,
} from './piper-voices.js';

/**
 * Language-aware TTS router.
 * Mode-specific providers are injected by the factory.
 */
export class LanguageTtsRouter extends TextToSpeechProvider {
  constructor({
    englishProvider,
    teluguProvider = null,
    defaultLanguage = 'en',
  } = {}) {
    super();
    if (!englishProvider && !teluguProvider) {
      throw new TtsProviderError(
        TTS_ERROR_CODES.NOT_CONFIGURED,
        'At least one TTS provider is required',
      );
    }
    this.englishProvider = englishProvider;
    this.teluguProvider = teluguProvider;
    this.defaultLanguage = defaultLanguage === 'te' ? 'te' : 'en';
  }

  async synthesize(input = {}) {
    const language = normalizeLanguage(input.language, this.defaultLanguage);
    if (!language) {
      throw new TtsProviderError(
        TTS_ERROR_CODES.LANGUAGE_NOT_CONFIGURED,
        'Unsupported TTS language',
        { statusCode: 400 },
      );
    }

    const voice = input.voice ? String(input.voice).trim() : '';
    if (voice) {
      if (language === 'te' && (isAllowedKokoroVoice(voice) || isEnglishPiperVoice(voice))) {
        throw new TtsProviderError(
          TTS_ERROR_CODES.LANGUAGE_VOICE_MISMATCH,
          'English voice cannot be used with Telugu text',
          { statusCode: 400 },
        );
      }
      if (language === 'en' && isTeluguPiperVoice(voice)) {
        throw new TtsProviderError(
          TTS_ERROR_CODES.LANGUAGE_VOICE_MISMATCH,
          'Telugu voice cannot be used with English text',
          { statusCode: 400 },
        );
      }
    }

    if (language === 'te') {
      if (!this.teluguProvider) {
        throw new TtsProviderError(
          TTS_ERROR_CODES.LANGUAGE_NOT_CONFIGURED,
          'Telugu TTS is not configured',
          { statusCode: 501 },
        );
      }
      return this.teluguProvider.synthesize({ ...input, language: 'te' });
    }

    if (!this.englishProvider) {
      throw new TtsProviderError(
        TTS_ERROR_CODES.LANGUAGE_NOT_CONFIGURED,
        'English TTS is not configured',
        { statusCode: 501 },
      );
    }
    return this.englishProvider.synthesize({ ...input, language: 'en' });
  }
}

/**
 * Normalize language aliases to en | te | null (unsupported).
 */
export function normalizeLanguage(value, fallback = 'en') {
  if (value == null || value === '') {
    if (fallback == null) return null;
    return fallback === 'te' ? 'te' : 'en';
  }
  const raw = String(value).trim().toLowerCase().replace(/_/g, '-');
  if (raw === 'auto') return fallback === 'te' ? 'te' : 'en';
  if (
    raw === 'te' ||
    raw === 'telugu' ||
    raw === 'te-in' ||
    raw.startsWith('te-')
  ) {
    return 'te';
  }
  if (
    raw === 'en' ||
    raw === 'english' ||
    raw === 'en-in' ||
    raw === 'en-us' ||
    raw.startsWith('en-')
  ) {
    return 'en';
  }
  return null;
}

/**
 * Outbound language priority:
 * 1. Explicit request language
 * 2. Campaign language
 * 3. Lead language
 * 4. Voice language metadata
 * 5. Safe configured default
 */
export function resolveSpeechLanguage({
  explicit,
  campaignLanguage,
  leadLanguage,
  voiceLanguage,
  defaultLanguage = 'en',
} = {}) {
  for (const candidate of [
    explicit,
    campaignLanguage,
    leadLanguage,
    voiceLanguage,
    defaultLanguage,
  ]) {
    const normalized = normalizeLanguage(candidate, null);
    if (normalized) return normalized;
  }
  return 'en';
}
