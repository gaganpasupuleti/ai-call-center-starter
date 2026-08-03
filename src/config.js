import path from 'node:path';
import {
  DEFAULT_VOICEBOT_PATH,
  STREAM_PATH,
} from './streaming/constants.js';

function envFlag(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).toLowerCase());
}

function normalizeExposureMode(value) {
  const mode = String(value ?? 'full').trim().toLowerCase();
  return mode === 'stream-only' ? 'stream-only' : 'full';
}

function normalizeStreamAuthMode(value) {
  const mode = String(value ?? 'disabled').trim().toLowerCase();
  if (mode === 'required') return 'required';
  if (mode === 'provider-compatible' || mode === 'provider_compatible') {
    return 'provider-compatible';
  }
  return 'disabled';
}

function normalizeWebhookAuthMode(value) {
  const mode = String(value ?? 'validation-only').trim().toLowerCase();
  if (mode === 'shared-secret' || mode === 'shared_secret') return 'shared-secret';
  if (mode === 'disabled') return 'disabled';
  return 'validation-only';
}

function normalizeWebhookPath(value) {
  const raw = String(value ?? '/webhooks/smartping/call-status').trim();
  if (!raw.startsWith('/')) return `/${raw}`;
  return raw.replace(/\/+$/, '') || '/webhooks/smartping/call-status';
}

function normalizePlaybackMode(value) {
  const mode = String(value ?? 'pipeline').trim().toLowerCase();
  if (mode === 'fixed-welcome' || mode === 'fixed_welcome') return 'fixed-welcome';
  return 'pipeline';
}

function normalizeVoiceResponseEngine(value) {
  const mode = String(value ?? 'deterministic').trim().toLowerCase();
  if (mode === 'mock') return 'mock';
  if (mode === 'deterministic') return 'deterministic';
  // Unknown values fall back to deterministic (safe default).
  return 'deterministic';
}

function normalizeVoiceSttProvider(value) {
  const mode = String(value ?? 'mock').trim().toLowerCase();
  if (mode === 'faster-whisper-streaming' || mode === 'faster_whisper_streaming') {
    return 'faster-whisper-streaming';
  }
  if (mode === 'mock') return 'mock';
  // Unknown values fall back to mock so production stays safe without the Python service.
  return 'mock';
}

function normalizeVoiceTtsProvider(value) {
  const mode = String(value ?? 'mock').trim().toLowerCase();
  if (mode === 'msedge' || mode === 'edge') {
    throw new Error(
      `VOICE_TTS_PROVIDER="${value}" is no longer supported. Microsoft Edge online TTS was removed. Use mock, local, kokoro, or piper.`,
    );
  }
  if (mode === 'mock' || mode === 'local' || mode === 'kokoro' || mode === 'piper') {
    return mode;
  }
  if (mode === '' || value == null) return 'mock';
  throw new Error(
    `Invalid VOICE_TTS_PROVIDER "${value}". Use mock, local, kokoro, or piper.`,
  );
}

function normalizeOutboundTtsProvider(value) {
  const mode = String(value ?? 'inherit').trim().toLowerCase();
  if (mode === 'msedge' || mode === 'edge') {
    throw new Error(
      `OUTBOUND_TTS_PROVIDER="${value}" is no longer supported. Microsoft Edge online TTS was removed. Use inherit, mock, local, kokoro, or piper.`,
    );
  }
  if (
    mode === 'inherit' ||
    mode === 'mock' ||
    mode === 'local' ||
    mode === 'kokoro' ||
    mode === 'piper'
  ) {
    return mode;
  }
  throw new Error(
    `Invalid OUTBOUND_TTS_PROVIDER "${value}". Use inherit, mock, local, kokoro, or piper.`,
  );
}

function normalizeVoiceInteractionMode(value) {
  const mode = String(value ?? 'dtmf').trim().toLowerCase();
  if (mode === 'dtmf' || mode === 'voice' || mode === 'voice-dtmf') return mode;
  throw new Error(
    `Invalid VOICE_INTERACTION_MODE "${value}". Use dtmf, voice, or voice-dtmf.`,
  );
}

export function getConfig(overrides = {}) {
  const cwd = process.cwd();
  const host = overrides.host ?? process.env.HOST ?? '127.0.0.1';
  const port = Number(overrides.port ?? process.env.PORT ?? 8787);
  const publicBaseUrl =
    overrides.publicBaseUrl ??
    process.env.PUBLIC_BASE_URL ??
    `http://${host}:${port}`;

  const smartPingOverrides = overrides.smartPing ?? {};
  const configuredStreamUrl =
    smartPingOverrides.streamUrl ?? process.env.SMARTPING_STREAM_URL ?? '';
  const streamUrl =
    configuredStreamUrl || `ws://${host}:${port}${STREAM_PATH}`;

  return {
    host,
    port,
    nodeEnv: overrides.nodeEnv ?? process.env.NODE_ENV ?? 'development',
    exposureMode: normalizeExposureMode(
      overrides.exposureMode ?? process.env.APP_EXPOSURE_MODE ?? 'full',
    ),
    databasePath:
      overrides.databasePath ??
      process.env.DATABASE_PATH ??
      path.join(cwd, 'data', 'call-center.db'),
    providerName: overrides.providerName ?? process.env.CALL_PROVIDER ?? 'mock',
    publicBaseUrl,
    webhookSecret:
      overrides.webhookSecret ??
      process.env.WEBHOOK_SECRET ??
      'development-webhook-secret',
    followUpLinkPlaceholder:
      overrides.followUpLinkPlaceholder ??
      process.env.FOLLOW_UP_LINK_PLACEHOLDER ??
      'https://example.com/register',
    smartPing: {
      baseUrl:
        smartPingOverrides.baseUrl ?? process.env.SMARTPING_BASE_URL ?? '',
      outboundPath:
        smartPingOverrides.outboundPath ??
        process.env.SMARTPING_OUTBOUND_PATH ??
        DEFAULT_VOICEBOT_PATH,
      apiToken:
        smartPingOverrides.apiToken ?? process.env.SMARTPING_API_TOKEN ?? '',
      didNumber:
        smartPingOverrides.didNumber ?? process.env.SMARTPING_DID_NUMBER ?? '',
      streamUrl,
      streamUrlConfigured: Boolean(configuredStreamUrl),
      dryRun:
        smartPingOverrides.dryRun ?? envFlag('SMARTPING_DRY_RUN', true),
      liveCallsEnabled:
        smartPingOverrides.liveCallsEnabled ??
        envFlag('SMARTPING_LIVE_CALLS_ENABLED', false),
      singleCallEnabled:
        smartPingOverrides.singleCallEnabled ??
        envFlag('SMARTPING_SINGLE_CALL_ENABLED', false),
      playbackMode: normalizePlaybackMode(
        smartPingOverrides.playbackMode ??
          process.env.SMARTPING_PLAYBACK_MODE ??
          'pipeline',
      ),
      welcomeAudioPath:
        smartPingOverrides.welcomeAudioPath ??
        process.env.SMARTPING_WELCOME_AUDIO_PATH ??
        '',
      storeAudio:
        smartPingOverrides.storeAudio ?? envFlag('SMARTPING_STORE_AUDIO', false),
      streamAuthMode: normalizeStreamAuthMode(
        smartPingOverrides.streamAuthMode ??
          process.env.SMARTPING_STREAM_AUTH_MODE ??
          'disabled',
      ),
      streamSharedSecret:
        smartPingOverrides.streamSharedSecret ??
        process.env.SMARTPING_STREAM_SHARED_SECRET ??
        '',
      maxConnections: Number(
        smartPingOverrides.maxConnections ??
          process.env.SMARTPING_STREAM_MAX_CONNECTIONS ??
          20,
      ),
      maxMessageBytes: Number(
        smartPingOverrides.maxMessageBytes ??
          process.env.SMARTPING_STREAM_MAX_MESSAGE_BYTES ??
          65_536,
      ),
      idleTimeoutMs: Number(
        smartPingOverrides.idleTimeoutMs ??
          process.env.SMARTPING_STREAM_IDLE_TIMEOUT_MS ??
          60_000,
      ),
      webhookPath: normalizeWebhookPath(
        smartPingOverrides.webhookPath ??
          process.env.SMARTPING_WEBHOOK_PATH ??
          '/webhooks/smartping/call-status',
      ),
      webhookAuthMode: normalizeWebhookAuthMode(
        smartPingOverrides.webhookAuthMode ??
          process.env.SMARTPING_WEBHOOK_AUTH_MODE ??
          'validation-only',
      ),
      webhookSharedSecret:
        smartPingOverrides.webhookSharedSecret ??
        process.env.SMARTPING_WEBHOOK_SHARED_SECRET ??
        '',
      webhookMaxBodyBytes: Number(
        smartPingOverrides.webhookMaxBodyBytes ??
          process.env.SMARTPING_WEBHOOK_MAX_BODY_BYTES ??
          16_384,
      ),
      webhookRateLimitPerMinute: Number(
        smartPingOverrides.webhookRateLimitPerMinute ??
          process.env.SMARTPING_WEBHOOK_RATE_LIMIT_PER_MINUTE ??
          60,
      ),
    },
    outbound: {
      ttsProvider: normalizeOutboundTtsProvider(
        overrides.outbound?.ttsProvider ??
          process.env.OUTBOUND_TTS_PROVIDER ??
          'inherit',
      ),
      ttsVoice:
        overrides.outbound?.ttsVoice ??
        process.env.OUTBOUND_TTS_VOICE ??
        'af_bella',
      dialerLive:
        overrides.outbound?.dialerLive ??
        envFlag('OUTBOUND_DIALER_LIVE', false),
    },
    voiceResponseEngine: normalizeVoiceResponseEngine(
      overrides.voiceResponseEngine ?? process.env.VOICE_RESPONSE_ENGINE,
    ),
    voiceSttProvider: normalizeVoiceSttProvider(
      overrides.voiceSttProvider ?? process.env.VOICE_STT_PROVIDER,
    ),
    voiceTtsProvider: normalizeVoiceTtsProvider(
      overrides.voiceTtsProvider ?? process.env.VOICE_TTS_PROVIDER,
    ),
    voiceConversationEnabled:
      overrides.voiceConversationEnabled ??
      envFlag('VOICE_CONVERSATION_ENABLED', false),
    voiceInteractionMode: normalizeVoiceInteractionMode(
      overrides.voiceInteractionMode ?? process.env.VOICE_INTERACTION_MODE,
    ),
    voiceMaxTurns: Number(
      overrides.voiceMaxTurns ?? process.env.VOICE_MAX_TURNS ?? 6,
    ),
    voiceListenTimeoutMs: Number(
      overrides.voiceListenTimeoutMs ??
        process.env.VOICE_LISTEN_TIMEOUT_MS ??
        12_000,
    ),
    voiceIdleHangupMs: Number(
      overrides.voiceIdleHangupMs ?? process.env.VOICE_IDLE_HANGUP_MS ?? 30_000,
    ),
    voiceResponseTimeoutMs: Number(
      overrides.voiceResponseTimeoutMs ??
        process.env.VOICE_RESPONSE_TIMEOUT_MS ??
        25_000,
    ),
    voicePendingTranscriptsMax: Number(
      overrides.voicePendingTranscriptsMax ??
        process.env.VOICE_PENDING_TRANSCRIPTS_MAX ??
        1,
    ),
    voiceIgnoreInputWhileSpeaking:
      overrides.voiceIgnoreInputWhileSpeaking ??
      envFlag('VOICE_IGNORE_INPUT_WHILE_SPEAKING', true),
    kokoro: {
      baseUrl:
        overrides.kokoro?.baseUrl ??
        process.env.KOKORO_BASE_URL ??
        'http://127.0.0.1:8880',
      model: overrides.kokoro?.model ?? process.env.KOKORO_MODEL ?? 'kokoro',
      defaultVoice:
        overrides.kokoro?.defaultVoice ??
        process.env.KOKORO_DEFAULT_VOICE ??
        'af_bella',
      defaultSpeed: Number(
        overrides.kokoro?.defaultSpeed ??
          process.env.KOKORO_DEFAULT_SPEED ??
          1.0,
      ),
      pcmSampleRate: Number(
        overrides.kokoro?.pcmSampleRate ??
          process.env.KOKORO_PCM_SAMPLE_RATE ??
          24000,
      ),
    },
    piper: {
      baseUrl:
        overrides.piper?.baseUrl ??
        process.env.PIPER_BASE_URL ??
        'http://127.0.0.1:5000',
      defaultVoice:
        overrides.piper?.defaultVoice ??
        process.env.PIPER_DEFAULT_VOICE ??
        'te_IN-padmavathi-medium',
      allowedVoices: String(
        overrides.piper?.allowedVoices ??
          process.env.PIPER_ALLOWED_VOICES ??
          'te_IN-padmavathi-medium,te_IN-venkatesh-medium',
      ),
      defaultSpeed: Number(
        overrides.piper?.defaultSpeed ??
          process.env.PIPER_DEFAULT_SPEED ??
          1.0,
      ),
      connectTimeoutMs: Number(
        overrides.piper?.connectTimeoutMs ??
          process.env.PIPER_CONNECT_TIMEOUT_MS ??
          5000,
      ),
      requestTimeoutMs: Number(
        overrides.piper?.requestTimeoutMs ??
          process.env.PIPER_REQUEST_TIMEOUT_MS ??
          20000,
      ),
      maxWavBytes: Number(
        overrides.piper?.maxWavBytes ??
          process.env.PIPER_MAX_WAV_BYTES ??
          8_388_608,
      ),
      maxTextChars: Number(
        overrides.piper?.maxTextChars ??
          process.env.PIPER_MAX_TEXT_CHARS ??
          600,
      ),
      maxConcurrentSynthesis: Number(
        overrides.piper?.maxConcurrentSynthesis ??
          process.env.PIPER_MAX_CONCURRENT_SYNTHESIS ??
          2,
      ),
    },
    tts: {
      connectTimeoutMs: Number(
        overrides.tts?.connectTimeoutMs ??
          process.env.TTS_CONNECT_TIMEOUT_MS ??
          5000,
      ),
      requestTimeoutMs: Number(
        overrides.tts?.requestTimeoutMs ??
          process.env.TTS_REQUEST_TIMEOUT_MS ??
          20000,
      ),
      maxTextChars: Number(
        overrides.tts?.maxTextChars ?? process.env.TTS_MAX_TEXT_CHARS ?? 600,
      ),
      maxPcmBytes: Number(
        overrides.tts?.maxPcmBytes ?? process.env.TTS_MAX_PCM_BYTES ?? 8_388_608,
      ),
      maxMulawBytes: Number(
        overrides.tts?.maxMulawBytes ??
          process.env.TTS_MAX_MULAW_BYTES ??
          160000,
      ),
      maxConcurrentSynthesis: Number(
        overrides.tts?.maxConcurrentSynthesis ??
          process.env.TTS_MAX_CONCURRENT_SYNTHESIS ??
          2,
      ),
      maxPendingRequests: Number(
        overrides.tts?.maxPendingRequests ??
          process.env.TTS_MAX_PENDING_REQUESTS ??
          10,
      ),
      defaultSpeed: Number(
        overrides.tts?.defaultSpeed ?? process.env.TTS_DEFAULT_SPEED ?? 1.0,
      ),
      minSpeed: Number(
        overrides.tts?.minSpeed ?? process.env.TTS_MIN_SPEED ?? 0.75,
      ),
      maxSpeed: Number(
        overrides.tts?.maxSpeed ?? process.env.TTS_MAX_SPEED ?? 1.25,
      ),
      cacheEnabled:
        overrides.tts?.cacheEnabled ?? envFlag('TTS_CACHE_ENABLED', true),
      cacheMaxEntries: Number(
        overrides.tts?.cacheMaxEntries ??
          process.env.TTS_CACHE_MAX_ENTRIES ??
          100,
      ),
      cacheMaxBytes: Number(
        overrides.tts?.cacheMaxBytes ??
          process.env.TTS_CACHE_MAX_BYTES ??
          52_428_800,
      ),
      cacheTtlMs: Number(
        overrides.tts?.cacheTtlMs ?? process.env.TTS_CACHE_TTL_MS ?? 3_600_000,
      ),
    },
    stt: {
      streamUrl:
        overrides.stt?.streamUrl ??
        process.env.STT_STREAM_URL ??
        'ws://127.0.0.1:8000/v1/stream',
      connectTimeoutMs: Number(
        overrides.stt?.connectTimeoutMs ??
          process.env.STT_CONNECT_TIMEOUT_MS ??
          5000,
      ),
      transcriptTimeoutMs: Number(
        overrides.stt?.transcriptTimeoutMs ??
          process.env.STT_TRANSCRIPT_TIMEOUT_MS ??
          20000,
      ),
      defaultLanguage: String(
        overrides.stt?.defaultLanguage ??
          process.env.STT_DEFAULT_LANGUAGE ??
          'en',
      )
        .trim()
        .toLowerCase(),
      maxPendingAudioBytes: Number(
        overrides.stt?.maxPendingAudioBytes ??
          process.env.STT_MAX_PENDING_AUDIO_BYTES ??
          16000,
      ),
      serviceToken:
        overrides.stt?.serviceToken ?? process.env.STT_SERVICE_TOKEN ?? '',
    },
  };
}

export function getPublicSettings(config, providerName) {
  const streamingConfigured = Boolean(
    config.smartPing.baseUrl &&
      config.smartPing.outboundPath &&
      config.smartPing.streamUrlConfigured,
  );
  return {
    activeProvider: providerName,
    mode: providerName === 'mock' ? 'mock' : providerName,
    mockMode: providerName === 'mock',
    smartPingMode: providerName === 'smartping',
    exposureMode: config.exposureMode,
    baseUrlConfigured: Boolean(config.smartPing.baseUrl),
    outboundPathConfigured: Boolean(config.smartPing.outboundPath),
    apiTokenConfigured: Boolean(config.smartPing.apiToken),
    didConfigured: Boolean(config.smartPing.didNumber),
    streamUrlConfigured: Boolean(config.smartPing.streamUrlConfigured),
    streamingConfigured,
    dryRunEnabled: config.smartPing.dryRun !== false,
    liveCallsEnabled: config.smartPing.liveCallsEnabled === true,
    liveCallsDisabled: config.smartPing.liveCallsEnabled !== true,
    singleCallEnabled: config.smartPing.singleCallEnabled === true,
    playbackMode: config.smartPing.playbackMode,
    storeAudioEnabled: config.smartPing.storeAudio === true,
    streamAuthMode: config.smartPing.streamAuthMode,
    streamAuthRequired: config.smartPing.streamAuthMode === 'required',
    streamAuthProviderCompatible:
      config.smartPing.streamAuthMode === 'provider-compatible',
    streamSharedSecretConfigured: Boolean(config.smartPing.streamSharedSecret),
    aiProvider: config.voiceResponseEngine || 'deterministic',
    voiceResponseEngine: config.voiceResponseEngine || 'deterministic',
    voiceSttProvider: config.voiceSttProvider || 'mock',
    voiceTtsProvider: config.voiceTtsProvider || 'mock',
    voiceConversationEnabled: config.voiceConversationEnabled === true,
    voiceInteractionMode: config.voiceInteractionMode || 'dtmf',
    kokoroConfigured: Boolean(config.kokoro?.baseUrl),
    kokoroDefaultVoice: config.kokoro?.defaultVoice || 'af_bella',
    piperConfigured: Boolean(config.piper?.baseUrl),
    piperDefaultVoice: config.piper?.defaultVoice || 'te_IN-padmavathi-medium',
    sttStreamUrlConfigured: Boolean(config.stt?.streamUrl),
    webhookAuthenticationConfigured: Boolean(config.webhookSecret),
    smartPingWebhookPath: config.smartPing.webhookPath,
    smartPingWebhookAuthMode: config.smartPing.webhookAuthMode,
    smartPingWebhookSharedSecretConfigured: Boolean(
      config.smartPing.webhookSharedSecret,
    ),
    publicBaseUrlConfigured: Boolean(config.publicBaseUrl),
    followUpLinkPlaceholder: config.followUpLinkPlaceholder,
    streamPathHint: STREAM_PATH,
    smartPingActivationMessage:
      'Public stream-only mode can use SMARTPING_STREAM_AUTH_MODE=provider-compatible. Stage 1 fixed-welcome playback uses SMARTPING_PLAYBACK_MODE=fixed-welcome. Campaign/bulk live calls stay blocked; a single controlled call requires LIVE + SINGLE_CALL flags, env credentials, and CLI --confirm.',
  };
}
