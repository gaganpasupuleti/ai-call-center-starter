import { existsSync } from 'node:fs';
import ffmpegPath from 'ffmpeg-static';
import { MockTextToSpeech } from '../ai/mock-tts.js';
import { KokoroTextToSpeech } from './kokoro-client.js';
import { PiperTextToSpeech } from './piper-client.js';
import { LanguageTtsRouter, resolveSpeechLanguage } from './language-router.js';
import { TtsProviderError, TTS_ERROR_CODES } from './errors.js';
import { BoundedTtsCache } from './bounded-tts-cache.js';
import { TtsConcurrencyLimiter } from './tts-concurrency.js';
import { KOKORO_DEFAULT_VOICE, isAllowedKokoroVoice } from './kokoro-voices.js';
import {
  PIPER_DEFAULT_VOICE,
  isAllowedPiperVoice,
} from './piper-voices.js';

const SUPPORTED_MODES = new Set(['mock', 'local', 'kokoro', 'piper']);

export class MsEdgeRemovedError extends Error {
  constructor(envName, value) {
    super(
      `${envName}=${value} is no longer supported. Microsoft Edge online TTS was removed because it contacts Microsoft’s speech service. Use mock, local, kokoro, or piper.`,
    );
    this.name = 'MsEdgeRemovedError';
    this.code = 'tts_msedge_removed';
  }
}

export function rejectLegacyMsEdge(value, envName = 'VOICE_TTS_PROVIDER') {
  const mode = String(value ?? '').trim().toLowerCase();
  if (mode === 'msedge' || mode === 'edge') {
    throw new MsEdgeRemovedError(envName, value);
  }
}

export function normalizeVoiceTtsProvider(value) {
  rejectLegacyMsEdge(value, 'VOICE_TTS_PROVIDER');
  const mode = String(value ?? 'mock').trim().toLowerCase();
  if (SUPPORTED_MODES.has(mode)) return mode;
  if (mode === '' || value == null) return 'mock';
  throw new TtsProviderError(
    TTS_ERROR_CODES.NOT_CONFIGURED,
    `Unknown VOICE_TTS_PROVIDER: ${value}. Use mock, local, kokoro, or piper.`,
    { statusCode: 500 },
  );
}

export function resolveOutboundTtsProvider(outboundValue, voiceTtsProvider) {
  rejectLegacyMsEdge(outboundValue, 'OUTBOUND_TTS_PROVIDER');
  const raw = String(outboundValue ?? 'inherit').trim().toLowerCase();
  if (raw === 'inherit' || raw === '') {
    return normalizeVoiceTtsProvider(voiceTtsProvider || 'mock');
  }
  if (SUPPORTED_MODES.has(raw)) return raw;
  throw new TtsProviderError(
    TTS_ERROR_CODES.NOT_CONFIGURED,
    `Unknown OUTBOUND_TTS_PROVIDER: ${outboundValue}. Use inherit, mock, local, kokoro, or piper.`,
    { statusCode: 500 },
  );
}

function buildSharedResources(ttsCfg, overrides = {}) {
  const cache =
    overrides.cache ||
    new BoundedTtsCache({
      enabled: ttsCfg.cacheEnabled !== false,
      maxEntries: ttsCfg.cacheMaxEntries,
      maxBytes: ttsCfg.cacheMaxBytes,
      ttlMs: ttsCfg.cacheTtlMs,
    });
  const limiter =
    overrides.limiter ||
    new TtsConcurrencyLimiter({
      maxConcurrent: ttsCfg.maxConcurrentSynthesis,
      maxPending: ttsCfg.maxPendingRequests,
    });
  return { cache, limiter };
}

function buildKokoro(config, overrides, shared) {
  const ttsCfg = config.tts || {};
  const kokoroCfg = config.kokoro || {};
  return (
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
      cache: shared.cache,
      limiter: shared.limiter,
      retryOnce: overrides.retryOnce,
    })
  );
}

function buildPiper(config, overrides, shared) {
  const ttsCfg = config.tts || {};
  const piperCfg = config.piper || {};
  const piperLimiter =
    overrides.piperLimiter ||
    new TtsConcurrencyLimiter({
      maxConcurrent:
        piperCfg.maxConcurrentSynthesis ?? ttsCfg.maxConcurrentSynthesis ?? 2,
      maxPending: ttsCfg.maxPendingRequests,
    });
  return (
    overrides.piper ||
    new PiperTextToSpeech({
      baseUrl: piperCfg.baseUrl,
      defaultVoice: piperCfg.defaultVoice || PIPER_DEFAULT_VOICE,
      defaultSpeed: piperCfg.defaultSpeed ?? ttsCfg.defaultSpeed ?? 1.0,
      connectTimeoutMs: piperCfg.connectTimeoutMs ?? ttsCfg.connectTimeoutMs,
      requestTimeoutMs: piperCfg.requestTimeoutMs ?? ttsCfg.requestTimeoutMs,
      maxTextChars: piperCfg.maxTextChars ?? ttsCfg.maxTextChars,
      maxWavBytes: piperCfg.maxWavBytes ?? ttsCfg.maxPcmBytes,
      maxMulawBytes: ttsCfg.maxMulawBytes,
      minSpeed: ttsCfg.minSpeed,
      maxSpeed: ttsCfg.maxSpeed,
      cacheEnabled: ttsCfg.cacheEnabled,
      cacheMaxEntries: ttsCfg.cacheMaxEntries,
      cacheMaxBytes: ttsCfg.cacheMaxBytes,
      cacheTtlMs: ttsCfg.cacheTtlMs,
      maxConcurrent: piperCfg.maxConcurrentSynthesis,
      maxPending: ttsCfg.maxPendingRequests,
      fetchImpl: overrides.fetchImpl,
      convert: overrides.piperConvert || overrides.convert,
      cache: shared.cache,
      limiter: piperLimiter,
      retryOnce: overrides.retryOnce,
    })
  );
}

/**
 * Single factory for conversational and outbound TTS.
 *
 * Modes:
 * - mock: all languages use mock TTS
 * - local: English → Kokoro, Telugu → Piper
 * - kokoro: English-only Kokoro
 * - piper: Telugu-only Piper
 */
export function createTextToSpeechProvider(config = {}, overrides = {}) {
  const mode = normalizeVoiceTtsProvider(
    overrides.provider ?? config.voiceTtsProvider ?? 'mock',
  );
  const ttsCfg = config.tts || {};
  const shared = buildSharedResources(ttsCfg, overrides);

  if (mode === 'mock') {
    const mock = overrides.mock || new MockTextToSpeech();
    if (overrides.router === false) return mock;
    return new LanguageTtsRouter({
      englishProvider: mock,
      teluguProvider: mock,
      defaultLanguage: ttsCfg.defaultLanguage || 'en',
    });
  }

  if (mode === 'kokoro') {
    const english = buildKokoro(config, overrides, shared);
    if (overrides.router === false) return english;
    return new LanguageTtsRouter({
      englishProvider: english,
      teluguProvider: overrides.teluguProvider || null,
      defaultLanguage: ttsCfg.defaultLanguage || 'en',
    });
  }

  if (mode === 'piper') {
    const telugu = buildPiper(config, overrides, shared);
    if (overrides.router === false) return telugu;
    return new LanguageTtsRouter({
      englishProvider: overrides.englishProvider || null,
      teluguProvider: telugu,
      defaultLanguage: ttsCfg.defaultLanguage || 'te',
    });
  }

  // local
  const english = buildKokoro(config, overrides, shared);
  const telugu = buildPiper(config, overrides, shared);
  if (overrides.router === false) {
    return english;
  }
  return new LanguageTtsRouter({
    englishProvider: english,
    teluguProvider: telugu,
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

  const voiceMetaLanguage = options.voiceLanguage
    || (isAllowedPiperVoice(options.voice) ? 'te' : null)
    || (isAllowedKokoroVoice(options.voice) ? 'en' : null)
    || (String(options.voice || '').startsWith('te') ? 'te' : null);

  const language = resolveSpeechLanguage({
    explicit: options.language,
    campaignLanguage: options.campaignLanguage,
    leadLanguage: options.leadLanguage,
    voiceLanguage: voiceMetaLanguage,
    defaultLanguage: config.tts?.defaultLanguage || 'en',
  });

  if (outboundMode === 'kokoro' && language === 'te') {
    throw new TtsProviderError(
      TTS_ERROR_CODES.LANGUAGE_NOT_CONFIGURED,
      'Telugu TTS requires VOICE_TTS_PROVIDER=local or piper',
      { statusCode: 501 },
    );
  }
  if (outboundMode === 'piper' && language === 'en') {
    throw new TtsProviderError(
      TTS_ERROR_CODES.LANGUAGE_NOT_CONFIGURED,
      'English TTS requires VOICE_TTS_PROVIDER=local or kokoro',
      { statusCode: 501 },
    );
  }

  const provider = createTextToSpeechProvider(
    {
      ...config,
      voiceTtsProvider: outboundMode,
    },
    {
      fetchImpl: options.fetchImpl,
      convert: options.convert,
      piperConvert: options.piperConvert,
      cache: options.cache,
      retryOnce: options.retryOnce,
    },
  );

  let voice = options.voice;
  if (language === 'en') {
    voice = isAllowedKokoroVoice(voice)
      ? voice
      : config.kokoro?.defaultVoice || KOKORO_DEFAULT_VOICE;
  } else if (language === 'te') {
    voice = isAllowedPiperVoice(voice)
      ? voice
      : config.piper?.defaultVoice || PIPER_DEFAULT_VOICE;
  }

  const speech = await provider.synthesize({
    text,
    language,
    voice,
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
    hasTeluguScript: speech.language === 'te',
    cached: speech.cached === true,
    cacheKey: null,
    synthesisDurationMs: speech.synthesisDurationMs,
  };
}

export class TtsError extends Error {
  constructor(message, code = 'tts_error', statusCode = 500) {
    super(message);
    this.name = 'TtsError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

const TELUGU_SCRIPT_RE = /[\u0C00-\u0C7F]/;

export function textHasTeluguScript(text) {
  return TELUGU_SCRIPT_RE.test(String(text ?? ''));
}

export function teluguVoiceNeedsTeluguScript(voice, text) {
  if (isAllowedPiperVoice(voice) || String(voice || '').toLowerCase().startsWith('te')) {
    return !textHasTeluguScript(text);
  }
  return false;
}

export function getTtsHealth({
  voice = process.env.OUTBOUND_TTS_VOICE || KOKORO_DEFAULT_VOICE,
  config = null,
} = {}) {
  const mode =
    config?.outbound?.ttsProvider ||
    process.env.OUTBOUND_TTS_PROVIDER ||
    'inherit';
  const voiceTts =
    config?.voiceTtsProvider || process.env.VOICE_TTS_PROVIDER || 'mock';
  let resolvedMode = 'mock';
  try {
    resolvedMode = resolveOutboundTtsProvider(mode, voiceTts);
  } catch {
    resolvedMode = 'error';
  }
  return {
    provider: resolvedMode,
    voice,
    ffmpegAvailable: Boolean(ffmpegPath && existsSync(ffmpegPath)),
    ready: Boolean(ffmpegPath && existsSync(ffmpegPath)),
    msedgeRemoved: true,
  };
}

/**
 * Safe combined health for local TTS stack (no private URLs).
 */
export async function getCombinedTtsHealth(config = {}) {
  const mode = normalizeVoiceTtsProvider(config.voiceTtsProvider || 'mock');
  const result = {
    mode,
    providers: {
      english: {
        provider: mode === 'mock' ? 'mock' : 'kokoro',
        configured: false,
        reachable: null,
        voice: config.kokoro?.defaultVoice || KOKORO_DEFAULT_VOICE,
      },
      telugu: {
        provider: mode === 'mock' ? 'mock' : 'piper',
        configured: false,
        reachable: null,
        voice: config.piper?.defaultVoice || PIPER_DEFAULT_VOICE,
      },
    },
  };

  if (mode === 'mock') {
    result.providers.english.configured = true;
    result.providers.english.reachable = true;
    result.providers.telugu.configured = true;
    result.providers.telugu.reachable = true;
    return result;
  }

  const shouldProbeKokoro = mode === 'local' || mode === 'kokoro';
  const shouldProbePiper = mode === 'local' || mode === 'piper';

  if (shouldProbeKokoro) {
    result.providers.english.configured = Boolean(config.kokoro?.baseUrl);
    if (result.providers.english.configured) {
      const client = new KokoroTextToSpeech({
        baseUrl: config.kokoro.baseUrl,
        defaultVoice: config.kokoro.defaultVoice,
        connectTimeoutMs: Math.min(3000, config.tts?.connectTimeoutMs || 3000),
        cacheEnabled: false,
      });
      const health = await client.getHealth();
      result.providers.english.reachable = health.reachable === true;
      result.providers.english.voice = health.defaultVoice || result.providers.english.voice;
    } else {
      result.providers.english.reachable = false;
    }
  } else {
    result.providers.english.provider = 'unavailable';
    result.providers.english.configured = false;
    result.providers.english.reachable = false;
  }

  if (shouldProbePiper) {
    result.providers.telugu.configured = Boolean(config.piper?.baseUrl);
    if (result.providers.telugu.configured) {
      const client = new PiperTextToSpeech({
        baseUrl: config.piper.baseUrl,
        defaultVoice: config.piper.defaultVoice,
        connectTimeoutMs: Math.min(
          3000,
          config.piper?.connectTimeoutMs || config.tts?.connectTimeoutMs || 3000,
        ),
        cacheEnabled: false,
      });
      const health = await client.getHealth();
      result.providers.telugu.reachable = health.reachable === true;
      result.providers.telugu.voice = health.defaultVoice || result.providers.telugu.voice;
    } else {
      result.providers.telugu.reachable = false;
    }
  } else {
    result.providers.telugu.provider = 'unavailable';
    result.providers.telugu.configured = false;
    result.providers.telugu.reachable = false;
  }

  return result;
}
