import { TextToSpeechProvider } from '../ai/interfaces.js';
import { AUDIO } from '../constants.js';
import { pcm24kToMulaw8k } from './audio-normalizer.js';
import { BoundedTtsCache } from './bounded-tts-cache.js';
import { TtsConcurrencyLimiter } from './tts-concurrency.js';
import { TtsProviderError, TTS_ERROR_CODES } from './errors.js';
import {
  KOKORO_DEFAULT_VOICE,
  filterRemoteVoices,
  validateKokoroVoice,
} from './kokoro-voices.js';

/**
 * Self-hosted Kokoro-FastAPI English TTS → μ-law 8 kHz for SmartPing.
 */
export class KokoroTextToSpeech extends TextToSpeechProvider {
  constructor(options = {}) {
    super();
    this.baseUrl = String(options.baseUrl || '').replace(/\/+$/, '');
    this.model = options.model || 'kokoro';
    this.defaultVoice = options.defaultVoice || KOKORO_DEFAULT_VOICE;
    this.defaultSpeed = clampSpeed(options.defaultSpeed ?? 1.0, options);
    this.pcmSampleRate = Number(options.pcmSampleRate || 24000);
    this.connectTimeoutMs = Number(options.connectTimeoutMs || 5000);
    this.requestTimeoutMs = Number(options.requestTimeoutMs || 20000);
    this.maxTextChars = Number(options.maxTextChars || 600);
    this.maxPcmBytes = Number(options.maxPcmBytes || 8_388_608);
    this.maxMulawBytes = Number(options.maxMulawBytes || 160_000);
    this.minSpeed = Number(options.minSpeed ?? 0.75);
    this.maxSpeed = Number(options.maxSpeed ?? 1.25);
    this.fetchImpl = options.fetchImpl || globalThis.fetch.bind(globalThis);
    this.convert = options.convert || pcm24kToMulaw8k;
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
    language = 'en',
    voice,
    speed,
    metadata = {},
  } = {}) {
    const started = Date.now();
    const lang = String(language || 'en').toLowerCase();
    if (lang !== 'en') {
      throw new TtsProviderError(
        TTS_ERROR_CODES.LANGUAGE_NOT_CONFIGURED,
        'Kokoro is English-only in Phase 4C',
        { statusCode: 400 },
      );
    }
    if (!this.baseUrl) {
      throw new TtsProviderError(
        TTS_ERROR_CODES.NOT_CONFIGURED,
        'Kokoro base URL is not configured',
        { statusCode: 503 },
      );
    }

    const trimmed = String(text ?? '').trim();
    if (!trimmed) {
      throw new TtsProviderError(
        TTS_ERROR_CODES.INVALID_RESPONSE,
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

    const selectedVoice = validateKokoroVoice(voice || this.defaultVoice);
    const selectedSpeed = clampSpeed(speed ?? this.defaultSpeed, this);
    const cacheKey = BoundedTtsCache.buildKey({
      provider: 'kokoro-local',
      language: 'en',
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
        provider: 'kokoro-local',
        voice: selectedVoice,
        language: 'en',
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

      let pcm;
      try {
        pcm = await this.#fetchPcm(trimmed, selectedVoice, selectedSpeed);
      } catch (err) {
        if (this._retryOnce && isRetryable(err)) {
          pcm = await this.#fetchPcm(trimmed, selectedVoice, selectedSpeed);
        } else {
          throw err;
        }
      }

      const converted = await this.convert(pcm, {
        inputSampleRate: this.pcmSampleRate,
        timeoutMs: this.requestTimeoutMs,
        maxMulawBytes: this.maxMulawBytes,
      });

      this.cache.set(cacheKey, converted.audio);

      return {
        audio: Buffer.from(converted.audio),
        format: converted.format,
        provider: 'kokoro-local',
        voice: selectedVoice,
        language: 'en',
        durationSeconds: converted.durationSeconds,
        synthesisDurationMs: Date.now() - started,
        cached: false,
      };
    });
  }

  async fetchVoices() {
    if (!this.baseUrl) {
      throw new TtsProviderError(
        TTS_ERROR_CODES.NOT_CONFIGURED,
        'Kokoro base URL is not configured',
      );
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.connectTimeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/v1/audio/voices`, {
        method: 'GET',
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new TtsProviderError(
          TTS_ERROR_CODES.HTTP_ERROR,
          `Voices endpoint returned ${response.status}`,
          { retryable: response.status >= 500 },
        );
      }
      const data = await response.json().catch(() => ({}));
      const list = Array.isArray(data) ? data : data.voices || data.data || [];
      return filterRemoteVoices(list);
    } catch (err) {
      if (err?.name === 'AbortError') {
        throw new TtsProviderError(
          TTS_ERROR_CODES.CONNECT_TIMEOUT,
          'Kokoro voices request timed out',
          { retryable: true },
        );
      }
      if (err instanceof TtsProviderError) throw err;
      throw new TtsProviderError(
        TTS_ERROR_CODES.CONNECT_FAILED,
        'Kokoro voices endpoint unreachable',
        { retryable: true },
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async getHealth() {
    const base = {
      provider: 'kokoro',
      configured: Boolean(this.baseUrl),
      reachable: false,
      defaultVoice: this.defaultVoice,
      language: 'en',
    };
    if (!this.baseUrl) return base;
    try {
      const voices = await this.fetchVoices();
      return {
        ...base,
        reachable: true,
        allowedVoices: voices,
      };
    } catch {
      return base;
    }
  }

  async #fetchPcm(text, voice, speed) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/v1/audio/speech`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          input: text,
          voice,
          response_format: 'pcm',
          speed,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new TtsProviderError(
          TTS_ERROR_CODES.HTTP_ERROR,
          `Kokoro speech returned HTTP ${response.status}`,
          {
            retryable: response.status >= 500 || response.status === 429,
            statusCode: 502,
          },
        );
      }

      const contentType = String(response.headers?.get?.('content-type') || '');
      if (
        contentType &&
        !/octet-stream|audio|pcm|application\/pcm/i.test(contentType) &&
        !/application\/json/i.test(contentType)
      ) {
        // Soft check — some servers omit content-type
      }

      const ab = await response.arrayBuffer();
      const pcm = Buffer.from(ab);
      if (!pcm.length) {
        throw new TtsProviderError(
          TTS_ERROR_CODES.EMPTY_RESPONSE,
          'Kokoro returned empty audio',
          { statusCode: 502 },
        );
      }
      if (pcm.length > this.maxPcmBytes) {
        throw new TtsProviderError(
          TTS_ERROR_CODES.RESPONSE_TOO_LARGE,
          'Kokoro PCM response exceeds size limit',
          { statusCode: 502 },
        );
      }
      return pcm;
    } catch (err) {
      if (err?.name === 'AbortError') {
        throw new TtsProviderError(
          TTS_ERROR_CODES.REQUEST_TIMEOUT,
          'Kokoro speech request timed out',
          { retryable: true },
        );
      }
      if (err instanceof TtsProviderError) throw err;
      throw new TtsProviderError(
        TTS_ERROR_CODES.CONNECT_FAILED,
        'Kokoro speech request failed',
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
    (err.code === TTS_ERROR_CODES.CONNECT_FAILED ||
      err.code === TTS_ERROR_CODES.CONNECT_TIMEOUT ||
      err.code === TTS_ERROR_CODES.REQUEST_TIMEOUT ||
      err.code === TTS_ERROR_CODES.HTTP_ERROR)
  );
}
