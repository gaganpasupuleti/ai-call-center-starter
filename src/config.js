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
  return mode === 'required' ? 'required' : 'disabled';
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
    storeAudioEnabled: config.smartPing.storeAudio === true,
    streamAuthMode: config.smartPing.streamAuthMode,
    streamAuthRequired: config.smartPing.streamAuthMode === 'required',
    streamSharedSecretConfigured: Boolean(config.smartPing.streamSharedSecret),
    aiProvider: 'mock',
    webhookAuthenticationConfigured: Boolean(config.webhookSecret),
    publicBaseUrlConfigured: Boolean(config.publicBaseUrl),
    followUpLinkPlaceholder: config.followUpLinkPlaceholder,
    streamPathHint: STREAM_PATH,
    smartPingActivationMessage:
      'Phase 3B can expose a public WebSocket stream endpoint in stream-only mode. Live CALL_PROVIDER=smartping calls remain disabled. Temporary stream auth is for Railway simulator protection only until SmartPing documents WebSocket authentication.',
  };
}
