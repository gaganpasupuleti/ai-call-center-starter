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
  PIPER_DEFAULT_ENGLISH_VOICE,
  PIPER_DEFAULT_ENGLISH_SPEAKER_ID,
  isAllowedPiperVoice,
  isEnglishPiperVoice,
  isTeluguPiperVoice,
} from './piper-voices.js';
import {
  createPrecomputedCatalogProvider,
  loadPrecomputedCatalog,
} from './precomputed-audio-catalog.js';

/**
 * Supported VOICE_TTS_PROVIDER modes (Phase 4E.3).
 * `local` remains an alias of `local-quality` for backward compatibility.
 */
const SUPPORTED_MODES = new Set([
  'mock',
  'local',
  'local-cpu',
  'local-quality',
  'precomputed-local',
  'kokoro',
  'piper',
]);

export class MsEdgeRemovedError extends Error {
  constructor(envName, value) {
    super(
      `${envName}=${value} is no longer supported. Microsoft Edge online TTS was removed because it contacts Microsoft’s speech service. Use mock, local-cpu, local-quality, precomputed-local, kokoro, or piper.`,
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
  let mode = String(value ?? 'mock').trim().toLowerCase();
  if (mode === '' || value == null) return 'mock';
  if (mode === 'local') mode = 'local-quality';
  if (
    mode === 'mock' ||
    mode === 'local-cpu' ||
    mode === 'local-quality' ||
    mode === 'precomputed-local' ||
    mode === 'kokoro' ||
    mode === 'piper'
  ) {
    return mode;
  }
  throw new TtsProviderError(
    TTS_ERROR_CODES.NOT_CONFIGURED,
    `Unknown VOICE_TTS_PROVIDER: ${value}. Use mock, local-cpu, local-quality, precomputed-local, kokoro, or piper.`,
    { statusCode: 500 },
  );
}

export function resolveOutboundTtsProvider(outboundValue, voiceTtsProvider) {
  rejectLegacyMsEdge(outboundValue, 'OUTBOUND_TTS_PROVIDER');
  const raw = String(outboundValue ?? 'inherit').trim().toLowerCase();
  if (raw === 'inherit' || raw === '') {
    return normalizeVoiceTtsProvider(voiceTtsProvider || 'mock');
  }
  return normalizeVoiceTtsProvider(raw);
}

/** Modes where English runtime TTS is Piper (not Kokoro). */
export function englishUsesPiper(mode) {
  const m = normalizeVoiceTtsProvider(mode);
  return m === 'local-cpu' || m === 'precomputed-local' || m === 'piper';
}

/** Modes that require Kokoro readiness. */
export function requiresKokoro(mode) {
  const m = normalizeVoiceTtsProvider(mode);
  return m === 'local-quality' || m === 'kokoro' || m === 'local';
}

/** Modes that require Piper readiness. */
export function requiresPiper(mode) {
  const m = normalizeVoiceTtsProvider(mode);
  return (
    m === 'local-cpu' ||
    m === 'local-quality' ||
    m === 'precomputed-local' ||
    m === 'piper' ||
    m === 'local'
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
        piperCfg.maxConcurrentSynthesis ?? ttsCfg.maxConcurrentSynthesis ?? 1,
      maxPending: ttsCfg.maxPendingRequests,
    });
  return (
    overrides.piper ||
    new PiperTextToSpeech({
      baseUrl: piperCfg.baseUrl,
      defaultVoice: piperCfg.defaultVoice || PIPER_DEFAULT_VOICE,
      defaultEnglishVoice:
        piperCfg.englishVoice || PIPER_DEFAULT_ENGLISH_VOICE,
      defaultEnglishSpeakerId:
        piperCfg.englishSpeakerId ?? PIPER_DEFAULT_ENGLISH_SPEAKER_ID,
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
 */
export function createTextToSpeechProvider(config = {}, overrides = {}) {
  const mode = normalizeVoiceTtsProvider(
    overrides.provider ?? config.voiceTtsProvider ?? 'mock',
  );
  const ttsCfg = config.tts || {};
  const shared = buildSharedResources(ttsCfg, overrides);
  const piper = () => buildPiper(config, overrides, shared);
  const kokoro = () => buildKokoro(config, overrides, shared);

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
    const english = kokoro();
    if (overrides.router === false) return english;
    return new LanguageTtsRouter({
      englishProvider: english,
      teluguProvider: overrides.teluguProvider || null,
      defaultLanguage: ttsCfg.defaultLanguage || 'en',
    });
  }

  if (mode === 'piper') {
    const only = piper();
    if (overrides.router === false) return only;
    return new LanguageTtsRouter({
      englishProvider: only,
      teluguProvider: only,
      defaultLanguage: ttsCfg.defaultLanguage || 'te',
    });
  }

  if (mode === 'local-cpu') {
    const both = piper();
    if (overrides.router === false) return both;
    return new LanguageTtsRouter({
      englishProvider: both,
      teluguProvider: both,
      defaultLanguage: ttsCfg.defaultLanguage || 'en',
    });
  }

  if (mode === 'precomputed-local') {
    const both = piper();
    const catalog = overrides.precomputedCatalog || loadPrecomputedCatalog(config);
    const english = createPrecomputedCatalogProvider({
      catalog,
      fallback: both,
      language: 'en',
    });
    const telugu = createPrecomputedCatalogProvider({
      catalog,
      fallback: both,
      language: 'te',
    });
    if (overrides.router === false) return english;
    return new LanguageTtsRouter({
      englishProvider: english,
      teluguProvider: telugu,
      defaultLanguage: ttsCfg.defaultLanguage || 'en',
    });
  }

  // local-quality (and legacy `local`)
  const english = kokoro();
  const telugu = piper();
  if (overrides.router === false) return english;
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
    || (isTeluguPiperVoice(options.voice) ? 'te' : null)
    || (isEnglishPiperVoice(options.voice) || isAllowedKokoroVoice(options.voice)
      ? 'en'
      : null)
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
      'Telugu TTS requires VOICE_TTS_PROVIDER=local-cpu, local-quality, or piper',
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
  let speakerId = options.speakerId;
  if (language === 'en') {
    if (englishUsesPiper(outboundMode)) {
      voice = isEnglishPiperVoice(voice)
        ? voice
        : config.piper?.englishVoice || PIPER_DEFAULT_ENGLISH_VOICE;
      speakerId =
        speakerId ??
        config.piper?.englishSpeakerId ??
        PIPER_DEFAULT_ENGLISH_SPEAKER_ID;
    } else {
      voice = isAllowedKokoroVoice(voice)
        ? voice
        : config.kokoro?.defaultVoice || KOKORO_DEFAULT_VOICE;
    }
  } else if (language === 'te') {
    voice = isTeluguPiperVoice(voice) || isAllowedPiperVoice(voice)
      ? voice
      : config.piper?.defaultVoice || PIPER_DEFAULT_VOICE;
  }

  const speech = await provider.synthesize({
    text,
    language,
    voice,
    speakerId,
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
    speakerId: speech.speakerId ?? null,
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
  if (isTeluguPiperVoice(voice) || String(voice || '').toLowerCase().startsWith('te')) {
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
  const enProvider = englishUsesPiper(mode)
    ? 'piper'
    : mode === 'mock'
      ? 'mock'
      : 'kokoro';
  const result = {
    mode,
    providers: {
      english: {
        provider: enProvider,
        configured: false,
        reachable: null,
        voice: englishUsesPiper(mode)
          ? config.piper?.englishVoice || PIPER_DEFAULT_ENGLISH_VOICE
          : config.kokoro?.defaultVoice || KOKORO_DEFAULT_VOICE,
        speakerId: englishUsesPiper(mode)
          ? config.piper?.englishSpeakerId ?? PIPER_DEFAULT_ENGLISH_SPEAKER_ID
          : null,
        required: mode !== 'mock' && (requiresKokoro(mode) || englishUsesPiper(mode)),
      },
      telugu: {
        provider: mode === 'mock' ? 'mock' : 'piper',
        configured: false,
        reachable: null,
        voice: config.piper?.defaultVoice || PIPER_DEFAULT_VOICE,
        required: mode !== 'mock' && requiresPiper(mode),
      },
      kokoroOptional: !requiresKokoro(mode),
    },
  };

  if (mode === 'mock') {
    result.providers.english.configured = true;
    result.providers.english.reachable = true;
    result.providers.telugu.configured = true;
    result.providers.telugu.reachable = true;
    return result;
  }

  const shouldProbeKokoro = requiresKokoro(mode);
  const shouldProbePiper = requiresPiper(mode) || englishUsesPiper(mode);

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
      result.providers.english.voice =
        health.defaultVoice || result.providers.english.voice;
    } else {
      result.providers.english.reachable = false;
    }
  } else if (englishUsesPiper(mode)) {
    // English health comes from Piper probe below
    result.providers.english.configured = Boolean(config.piper?.baseUrl);
  } else {
    result.providers.english.provider = 'unavailable';
    result.providers.english.configured = false;
    result.providers.english.reachable = false;
  }

  if (shouldProbePiper) {
    const piperConfigured = Boolean(config.piper?.baseUrl);
    result.providers.telugu.configured = piperConfigured;
    if (englishUsesPiper(mode)) {
      result.providers.english.configured = piperConfigured;
    }
    if (piperConfigured) {
      const client = new PiperTextToSpeech({
        baseUrl: config.piper.baseUrl,
        defaultVoice: config.piper.defaultVoice,
        defaultEnglishVoice: config.piper.englishVoice,
        defaultEnglishSpeakerId: config.piper.englishSpeakerId,
        connectTimeoutMs: Math.min(
          3000,
          config.piper?.connectTimeoutMs || config.tts?.connectTimeoutMs || 3000,
        ),
        cacheEnabled: false,
      });
      const health = await client.getHealth();
      const reachable = health.reachable === true;
      result.providers.telugu.reachable = reachable;
      if (englishUsesPiper(mode)) {
        result.providers.english.reachable = reachable;
      }
    } else {
      result.providers.telugu.reachable = false;
      if (englishUsesPiper(mode)) {
        result.providers.english.reachable = false;
      }
    }
  } else {
    result.providers.telugu.provider = 'unavailable';
    result.providers.telugu.configured = false;
    result.providers.telugu.reachable = false;
  }

  // Optional Kokoro probe for informational status when not required
  if (!shouldProbeKokoro && config.kokoro?.baseUrl) {
    result.optionalKokoro = { configured: true, reachable: null };
    try {
      const client = new KokoroTextToSpeech({
        baseUrl: config.kokoro.baseUrl,
        connectTimeoutMs: 2000,
        cacheEnabled: false,
      });
      const health = await client.getHealth();
      result.optionalKokoro.reachable = health.reachable === true;
    } catch {
      result.optionalKokoro.reachable = false;
    }
  }

  return result;
}
