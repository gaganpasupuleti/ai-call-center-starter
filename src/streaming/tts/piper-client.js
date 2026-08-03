import { TextToSpeechProvider } from '../ai/interfaces.js';
import { AUDIO } from '../constants.js';
import { wavToMulaw8k, isLikelyWav } from './audio-normalizer.js';
import { BoundedTtsCache } from './bounded-tts-cache.js';
import { TtsConcurrencyLimiter } from './tts-concurrency.js';
import { TtsProviderError, TTS_ERROR_CODES } from './errors.js';
import {
  PIPER_DEFAULT_VOICE,
  validatePiperVoice,
  speedToLengthScale,
} from './piper-voices.js';
import { isAllowedKokoroVoice } from './kokoro-voices.js';

/**
 * Self-hosted Piper HTTP Telugu TTS → μ-law 8 kHz for SmartPing.
 */
export class PiperTextToSpeech extends TextToSpeechProvider {
  constructor(options = {}) {
    super();
    this.baseUrl = String(options.baseUrl || '').replace(/\/+$/, '');
    this.defaultVoice = options.defaultVoice || PIPER_DEFAULT_VOICE;
    this.defaultSpeed = clampSpeed(options.defaultSpeed ?? 1.0, options);
    this.connectTimeoutMs = Number(options.connectTimeoutMs || 5000);
    this.requestTimeoutMs = Number(options.requestTimeoutMs || 20000);
    this.maxTextChars = Number(options.maxTextChars || 600);
    this.maxWavBytes = Number(options.maxWavBytes || 8_388_608);
    this.maxMulawBytes = Number(options.maxMulawBytes || 160_000);
    this.minSpeed = Number(options.minSpeed ?? 0.75);
    this.maxSpeed = Number(options.maxSpeed ?? 1.25);
    this.minLengthScale = Number(options.minLengthScale ?? 0.8);
    this.maxLengthScale = Number(options.maxLengthScale ?? 1.33);
    this.fetchImpl = options.fetchImpl || globalThis.fetch.bind(globalThis);
    this.convert = options.convert || wavToMulaw8k;
    this.cache =
      options.cache ||
      new BoundedTtsCache({
        enabled: options.cacheEnabled !== false,
        maxEntries: options.cacheMaxEntries,
        maxBytes: options.cacheMaxBytes,
        ttlMs: options.cacheTtlMs,
      });
    this.limiter =
      options.limiter ||
      new TtsConcurrencyLimiter({
        maxConcurrent: options.maxConcurrent,
        maxPending: options.maxPending,
      });
    this._retryOnce = options.retryOnce !== false;
  }

  async synthesize({
    text,
    language = 'te',
    voice,
    speed,
    metadata = {},
  } = {}) {
    const started = Date.now();
    const lang = String(language || 'te').toLowerCase();
    if (lang !== 'te') {
      throw new TtsProviderError(
        TTS_ERROR_CODES.LANGUAGE_NOT_CONFIGURED,
        'Piper is Telugu-only in Phase 4D',
        { statusCode: 400 },
      );
    }
    if (!this.baseUrl) {
      throw new TtsProviderError(
        TTS_ERROR_CODES.PIPER_NOT_CONFIGURED,
        'Piper base URL is not configured',
        { statusCode: 503 },
      );
    }

    const trimmed = String(text ?? '').trim();
    if (!trimmed) {
      throw new TtsProviderError(
        TTS_ERROR_CODES.PIPER_INVALID_RESPONSE,
        'TTS text is required',
        { statusCode: 400 },
      );
    }
    if (trimmed.length > this.maxTextChars) {
      throw new TtsProviderError(
        TTS_ERROR_CODES.TEXT_TOO_LONG,
        'TTS text exceeds configured limit',
        { statusCode: 400 },
      );
    }

    if (voice && isAllowedKokoroVoice(voice)) {
      throw new TtsProviderError(
        TTS_ERROR_CODES.LANGUAGE_VOICE_MISMATCH,
        'English Kokoro voice cannot be used for Telugu synthesis',
        { statusCode: 400 },
      );
    }

    const selectedVoice = validatePiperVoice(voice || this.defaultVoice);
    const selectedSpeed = clampSpeed(speed ?? this.defaultSpeed, this);
    const lengthScale = speedToLengthScale(selectedSpeed, this);
    const cacheKey = BoundedTtsCache.buildKey({
      provider: 'piper-local',
      language: 'te',
      voice: selectedVoice,
      speed: selectedSpeed,
      text: trimmed,
    });

    const cached = this.cache.get(cacheKey);
    if (cached) {
      return {
        audio: cached,
        format: {
          encoding: 'mulaw',
          sampleRate: AUDIO.sampleRate,
          channels: 1,
        },
        provider: 'piper-local',
        voice: selectedVoice,
        language: 'te',
        durationSeconds: Number((cached.length / AUDIO.sampleRate).toFixed(3)),
        synthesisDurationMs: Date.now() - started,
        cached: true,
      };
    }

    return this.limiter.run(async () => {
      if (metadata?.sessionClosed === true) {
        throw new TtsProviderError(
          TTS_ERROR_CODES.SESSION_CLOSED,
          'Call session closed before synthesis',
          { statusCode: 409 },
        );
      }

      let wav;
      try {
        wav = await this.#fetchWav(trimmed, selectedVoice, lengthScale);
      } catch (err) {
        if (this._retryOnce && isRetryable(err)) {
          wav = await this.#fetchWav(trimmed, selectedVoice, lengthScale);
        } else {
          throw err;
        }
      }

      const converted = await this.convert(wav, {
        timeoutMs: this.requestTimeoutMs,
        maxMulawBytes: this.maxMulawBytes,
      });

      this.cache.set(cacheKey, converted.audio);

      return {
        audio: Buffer.from(converted.audio),
        format: converted.format,
        provider: 'piper-local',
        voice: selectedVoice,
        language: 'te',
        durationSeconds: converted.durationSeconds,
        synthesisDurationMs: Date.now() - started,
        cached: false,
      };
    });
  }

  async fetchInfo() {
    return this.#getJson('/info', this.connectTimeoutMs);
  }

  async fetchVoices() {
    const data = await this.#getJson('/voices', this.connectTimeoutMs);
    if (Array.isArray(data)) return data;
    if (data && typeof data === 'object') {
      if (Array.isArray(data.voices)) return data.voices;
      return Object.keys(data);
    }
    return [];
  }

  async getHealth() {
    const base = {
      provider: 'piper',
      configured: Boolean(this.baseUrl),
      reachable: false,
      defaultVoice: this.defaultVoice,
      language: 'te',
    };
    if (!this.baseUrl) return base;
    try {
      await this.fetchInfo();
      const voices = await this.fetchVoices();
      return {
        ...base,
        reachable: true,
        voiceCount: Array.isArray(voices) ? voices.length : undefined,
      };
    } catch {
      return base;
    }
  }

  async #getJson(path, timeoutMs) {
    if (!this.baseUrl) {
      throw new TtsProviderError(
        TTS_ERROR_CODES.PIPER_NOT_CONFIGURED,
        'Piper base URL is not configured',
      );
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: 'GET',
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new TtsProviderError(
          TTS_ERROR_CODES.PIPER_HTTP_ERROR,
          `Piper ${path} returned ${response.status}`,
          { retryable: response.status >= 500 },
        );
      }
      return await response.json().catch(() => ({}));
    } catch (err) {
      if (err?.name === 'AbortError') {
        throw new TtsProviderError(
          TTS_ERROR_CODES.PIPER_CONNECT_TIMEOUT,
          'Piper request timed out',
          { retryable: true },
        );
      }
      if (err instanceof TtsProviderError) throw err;
      throw new TtsProviderError(
        TTS_ERROR_CODES.PIPER_CONNECT_FAILED,
        'Piper endpoint unreachable',
        { retryable: true },
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async #fetchWav(text, voice, lengthScale) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/synthesize`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          text,
          voice,
          length_scale: lengthScale,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        if (response.status === 404) {
          throw new TtsProviderError(
            TTS_ERROR_CODES.PIPER_MODEL_UNAVAILABLE,
            'Piper voice model is unavailable',
            { statusCode: 502 },
          );
        }
        throw new TtsProviderError(
          TTS_ERROR_CODES.PIPER_HTTP_ERROR,
          `Piper synthesize returned HTTP ${response.status}`,
          {
            retryable: response.status >= 500 || response.status === 429,
            statusCode: 502,
          },
        );
      }

      const contentType = String(response.headers?.get?.('content-type') || '');
      if (
        contentType &&
        !/wav|audio|octet-stream/i.test(contentType) &&
        !/application\/octet-stream/i.test(contentType)
      ) {
        // Soft check — some servers omit or use generic types
      }

      const ab = await response.arrayBuffer();
      const wav = Buffer.from(ab);
      if (!wav.length) {
        throw new TtsProviderError(
          TTS_ERROR_CODES.PIPER_EMPTY_RESPONSE,
          'Piper returned empty audio',
          { statusCode: 502 },
        );
      }
      if (wav.length > this.maxWavBytes) {
        throw new TtsProviderError(
          TTS_ERROR_CODES.PIPER_RESPONSE_TOO_LARGE,
          'Piper WAV response exceeds size limit',
          { statusCode: 502 },
        );
      }
      if (!isLikelyWav(wav)) {
        throw new TtsProviderError(
          TTS_ERROR_CODES.PIPER_INVALID_RESPONSE,
          'Piper response is not a valid WAV',
          { statusCode: 502 },
        );
      }
      return wav;
    } catch (err) {
      if (err?.name === 'AbortError') {
        throw new TtsProviderError(
          TTS_ERROR_CODES.PIPER_REQUEST_TIMEOUT,
          'Piper synthesize request timed out',
          { retryable: true },
        );
      }
      if (err instanceof TtsProviderError) throw err;
      throw new TtsProviderError(
        TTS_ERROR_CODES.PIPER_CONNECT_FAILED,
        'Piper synthesize request failed',
        { retryable: true },
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

function clampSpeed(speed, bounds = {}) {
  const min = Number(bounds.minSpeed ?? 0.75);
  const max = Number(bounds.maxSpeed ?? 1.25);
  const n = Number(speed);
  if (!Number.isFinite(n)) return 1.0;
  return Math.min(max, Math.max(min, n));
}

function isRetryable(err) {
  return (
    err instanceof TtsProviderError &&
    err.retryable &&
    (err.code === TTS_ERROR_CODES.PIPER_CONNECT_FAILED ||
      err.code === TTS_ERROR_CODES.PIPER_CONNECT_TIMEOUT ||
      err.code === TTS_ERROR_CODES.PIPER_REQUEST_TIMEOUT ||
      err.code === TTS_ERROR_CODES.PIPER_HTTP_ERROR)
  );
}
