import { MockTextToSpeech } from '../ai/mock-tts.js';
import { TextToSpeechProvider } from '../ai/interfaces.js';
import { AUDIO } from '../constants.js';
import { KokoroTextToSpeech } from './kokoro-client.js';
import { LanguageTtsRouter } from './language-router.js';
import { TtsProviderError, TTS_ERROR_CODES } from './errors.js';
import { synthesizeToMulaw } from './synthesize.js';
import { KOKORO_DEFAULT_VOICE, isAllowedKokoroVoice } from './kokoro-voices.js';

/**
 * Legacy Microsoft Edge TTS adapter (explicit opt-in only).
 */
export class MsEdgeTextToSpeech extends TextToSpeechProvider {
  constructor(options = {}) {
    super();
    this.defaultVoice = options.defaultVoice || 'en-IN-NeerjaNeural';
    this.synthesizeFn = options.synthesizeFn || synthesizeToMulaw;
  }

  async synthesize({ text, voice, metadata } = {}) {
    const result = await this.synthesizeFn(text, {
      voice: voice || this.defaultVoice,
    });
    return {
      audio: Buffer.from(result.bytes),
      format: {
        encoding: 'mulaw',
        sampleRate: AUDIO.sampleRate,
        channels: 1,
      },
      provider: 'msedge',
      voice: result.voice,
      language: result.locale?.startsWith('te') ? 'te' : 'en',
      durationSeconds: result.durationSeconds,
      synthesisDurationMs: null,
      cached: result.cached === true,
      metadata,
    };
  }
}

export function normalizeVoiceTtsProvider(value) {
  const mode = String(value ?? 'mock').trim().toLowerCase();
  if (mode === 'mock' || mode === 'kokoro' || mode === 'msedge') return mode;
  if (mode === 'edge') return 'msedge';
  throw new TtsProviderError(
    TTS_ERROR_CODES.NOT_CONFIGURED,
    `Unknown VOICE_TTS_PROVIDER: ${value}`,
    { statusCode: 500 },
  );
}

export function resolveOutboundTtsProvider(outboundValue, voiceTtsProvider) {
  const raw = String(outboundValue ?? 'inherit').trim().toLowerCase();
  if (raw === 'inherit' || raw === '') {
    return normalizeVoiceTtsProvider(voiceTtsProvider || 'mock');
  }
  if (raw === 'edge') return 'msedge';
  if (raw === 'mock' || raw === 'kokoro' || raw === 'msedge') return raw;
  throw new TtsProviderError(
    TTS_ERROR_CODES.NOT_CONFIGURED,
    `Unknown OUTBOUND_TTS_PROVIDER: ${outboundValue}`,
    { statusCode: 500 },
  );
}

/**
 * Single factory for conversational and outbound TTS.
 */
export function createTextToSpeechProvider(config = {}, overrides = {}) {
  const mode = normalizeVoiceTtsProvider(
    overrides.provider ?? config.voiceTtsProvider ?? 'mock',
  );
  const ttsCfg = config.tts || {};
  const kokoroCfg = config.kokoro || {};

  let english;
  if (mode === 'mock') {
    english = overrides.mock || new MockTextToSpeech();
  } else if (mode === 'kokoro') {
    english =
      overrides.kokoro ||
      new KokoroTextToSpeech({
        baseUrl: kokoroCfg.baseUrl || ttsCfg.kokoroBaseUrl,
        model: kokoroCfg.model || 'kokoro',
        defaultVoice: kokoroCfg.defaultVoice || KOKORO_DEFAULT_VOICE,
        defaultSpeed: kokoroCfg.defaultSpeed ?? ttsCfg.defaultSpeed ?? 1.0,
        pcmSampleRate: kokoroCfg.pcmSampleRate || 24000,
        connectTimeoutMs: ttsCfg.connectTimeoutMs,
        requestTimeoutMs: ttsCfg.requestTimeoutMs,
        maxTextChars: ttsCfg.maxTextChars,
        maxPcmBytes: ttsCfg.maxPcmBytes,
        maxMulawBytes: ttsCfg.maxMulawBytes,
        minSpeed: ttsCfg.minSpeed,
        maxSpeed: ttsCfg.maxSpeed,
        cacheEnabled: ttsCfg.cacheEnabled,
        cacheMaxEntries: ttsCfg.cacheMaxEntries,
        cacheMaxBytes: ttsCfg.cacheMaxBytes,
        cacheTtlMs: ttsCfg.cacheTtlMs,
        maxConcurrent: ttsCfg.maxConcurrentSynthesis,
        maxPending: ttsCfg.maxPendingRequests,
        fetchImpl: overrides.fetchImpl,
        convert: overrides.convert,
        cache: overrides.cache,
        limiter: overrides.limiter,
        retryOnce: overrides.retryOnce,
      });
  } else if (mode === 'msedge') {
    english =
      overrides.msedge ||
      new MsEdgeTextToSpeech({
        defaultVoice: config.outbound?.ttsVoice || 'en-IN-NeerjaNeural',
        synthesizeFn: overrides.synthesizeFn,
      });
  } else {
    throw new TtsProviderError(
      TTS_ERROR_CODES.NOT_CONFIGURED,
      `Unsupported TTS provider: ${mode}`,
    );
  }

  if (overrides.router === false) return english;

  return new LanguageTtsRouter({
    englishProvider: english,
    teluguProvider: overrides.teluguProvider || null,
    defaultLanguage: ttsCfg.defaultLanguage || 'en',
  });
}

/**
 * Helper used by outbound dialer to synthesize μ-law with provider routing.
 */
export async function synthesizeOutboundAudio(text, options = {}, config = {}) {
  const voiceTts = config.voiceTtsProvider || process.env.VOICE_TTS_PROVIDER || 'mock';
  const outboundMode = resolveOutboundTtsProvider(
    options.provider ??
      config.outbound?.ttsProvider ??
      process.env.OUTBOUND_TTS_PROVIDER ??
      'inherit',
    voiceTts,
  );

  if (outboundMode === 'msedge') {
    const result = await synthesizeToMulaw(text, {
      voice: options.voice,
      requireMatchingScript: options.requireMatchingScript,
    });
    return {
      bytes: result.bytes,
      byteLength: result.byteLength,
      durationSeconds: result.durationSeconds,
      sampleRate: 8000,
      channels: 1,
      encoding: 'audio/x-mulaw',
      energyRatio: result.energyRatio,
      provider: 'msedge',
      voice: result.voice,
      requestedVoice: result.requestedVoice,
      locale: result.locale,
      scriptMismatch: result.scriptMismatch,
      hasTeluguScript: result.hasTeluguScript,
      cached: result.cached,
      cacheKey: result.cacheKey,
    };
  }

  const language =
    options.language ||
    (String(options.voice || '').startsWith('te') ? 'te' : 'en');

  if (outboundMode === 'kokoro' && language === 'te') {
    throw new TtsProviderError(
      TTS_ERROR_CODES.LANGUAGE_NOT_CONFIGURED,
      'Telugu TTS is not configured until Phase 4D',
      { statusCode: 501 },
    );
  }

  const provider = createTextToSpeechProvider(
    {
      ...config,
      voiceTtsProvider: outboundMode,
    },
    { router: outboundMode === 'kokoro', fetchImpl: options.fetchImpl, convert: options.convert, cache: options.cache },
  );

  const speech = await provider.synthesize({
    text,
    language,
    voice:
      outboundMode === 'kokoro'
        ? isAllowedKokoroVoice(options.voice)
          ? options.voice
          : config.kokoro?.defaultVoice || KOKORO_DEFAULT_VOICE
        : options.voice,
    speed: options.speed,
  });

  return {
    bytes: speech.audio,
    byteLength: speech.audio.length,
    durationSeconds: speech.durationSeconds,
    sampleRate: 8000,
    channels: 1,
    encoding: 'audio/x-mulaw',
    energyRatio: 1,
    provider: speech.provider,
    voice: speech.voice,
    requestedVoice: speech.voice,
    locale: speech.language === 'te' ? 'te-IN' : 'en-IN',
    scriptMismatch: false,
    hasTeluguScript: false,
    cached: speech.cached === true,
    cacheKey: null,
    synthesisDurationMs: speech.synthesisDurationMs,
  };
}
