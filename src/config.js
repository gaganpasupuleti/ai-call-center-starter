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
      ttsProvider:
        overrides.outbound?.ttsProvider ??
        process.env.OUTBOUND_TTS_PROVIDER ??
        'edge',
      ttsVoice:
        overrides.outbound?.ttsVoice ??
        process.env.OUTBOUND_TTS_VOICE ??
        'en-IN-NeerjaNeural',
      dialerLive:
        overrides.outbound?.dialerLive ??
        envFlag('OUTBOUND_DIALER_LIVE', false),
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
    aiProvider: 'mock',
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
