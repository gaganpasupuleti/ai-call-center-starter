import { TextToSpeechProvider } from '../ai/interfaces.js';
import { TtsProviderError, TTS_ERROR_CODES } from './errors.js';

/**
 * Language-aware TTS router.
 * Phase 4C: English → Kokoro (or mock/msedge). Telugu → unavailable until 4D.
 */
export class LanguageTtsRouter extends TextToSpeechProvider {
  constructor({
    englishProvider,
    teluguProvider = null,
    defaultLanguage = 'en',
  } = {}) {
    super();
    if (!englishProvider) {
      throw new TtsProviderError(
        TTS_ERROR_CODES.NOT_CONFIGURED,
        'English TTS provider is required',
      );
    }
    this.englishProvider = englishProvider;
    this.teluguProvider = teluguProvider;
    this.defaultLanguage = defaultLanguage === 'te' ? 'te' : 'en';
  }

  async synthesize(input = {}) {
    const language = normalizeLanguage(input.language, this.defaultLanguage);
    if (language === 'te') {
      if (!this.teluguProvider) {
        throw new TtsProviderError(
          TTS_ERROR_CODES.LANGUAGE_NOT_CONFIGURED,
          'Telugu TTS is not configured until Phase 4D',
          { statusCode: 501 },
        );
      }
      return this.teluguProvider.synthesize({ ...input, language: 'te' });
    }
    return this.englishProvider.synthesize({ ...input, language: 'en' });
  }
}

function normalizeLanguage(value, fallback = 'en') {
  const raw = String(value || fallback).trim().toLowerCase();
  if (raw === 'te' || raw === 'telugu' || raw.startsWith('te-')) return 'te';
  if (raw === 'en' || raw === 'english' || raw.startsWith('en-') || raw === 'auto') {
    return 'en';
  }
  return 'en';
}
