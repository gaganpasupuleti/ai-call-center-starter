import { DEFAULT_VOICEBOT_PATH } from '../constants.js';
import { redactHeaders, redactSecret } from '../redaction.js';

export class SmartPingLiveCallsDisabledError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SmartPingLiveCallsDisabledError';
    this.statusCode = 403;
  }
}

export function buildVoicebotCallRequest({
  baseUrl,
  outboundPath = DEFAULT_VOICEBOT_PATH,
  apiToken,
  phoneNumber,
  didNumber,
  streamUrl,
  customParameters = {},
}) {
  if (!baseUrl) {
    throw Object.assign(new Error('SMARTPING_BASE_URL is required'), {
      statusCode: 400,
    });
  }
  if (!phoneNumber) {
    throw Object.assign(new Error('phone_number is required'), { statusCode: 400 });
  }
  if (!didNumber) {
    throw Object.assign(new Error('did_number is required'), { statusCode: 400 });
  }
  if (!streamUrl) {
    throw Object.assign(new Error('stream url is required'), { statusCode: 400 });
  }

  const normalizedBase = String(baseUrl).replace(/\/+$/, '');
  const normalizedPath = String(outboundPath || DEFAULT_VOICEBOT_PATH).startsWith('/')
    ? String(outboundPath || DEFAULT_VOICEBOT_PATH)
    : `/${outboundPath}`;

  const headers = {
    'Content-Type': 'application/json',
    'x-api-token': apiToken || '',
  };

  const body = {
    phone_number: phoneNumber,
    did_number: didNumber,
    url: streamUrl,
    channel_vars: {
      custom_parameters: customParameters,
    },
  };

  return {
    method: 'POST',
    url: `${normalizedBase}${normalizedPath}`,
    headers,
    body,
  };
}

export function toRedactedRequestPreview(request) {
  return {
    method: request.method,
    url: request.url,
    headers: redactHeaders(request.headers),
    body: request.body,
    tokenConfigured: Boolean(request.headers['x-api-token']),
    redactedToken: redactSecret(request.headers['x-api-token']),
  };
}

/**
 * Fail-closed outbound executor.
 * Dry-run never touches the network. Live calls require explicit enablement.
 */
export async function executeVoicebotCall(
  config,
  {
    phoneNumber,
    didNumber,
    streamUrl,
    customParameters,
    fetchImpl = globalThis.fetch,
  },
) {
  const request = buildVoicebotCallRequest({
    baseUrl: config.baseUrl,
    outboundPath: config.outboundPath,
    apiToken: config.apiToken,
    phoneNumber,
    didNumber: didNumber ?? config.didNumber,
    streamUrl: streamUrl ?? config.streamUrl,
    customParameters,
  });

  // Phase 3A is fail-closed: never place a live SmartPing call.
  if (config.dryRun !== false) {
    return {
      dryRun: true,
      networkRequestMade: false,
      preview: toRedactedRequestPreview(request),
    };
  }

  throw new SmartPingLiveCallsDisabledError(
    'Live SmartPing voicebot calls are disabled (Phase 3A fail-closed). Use dry-run previews only.',
  );
}

// Keep an unreachable live path isolated for future Phase work.
export async function __dangerousLiveVoicebotCall(request, fetchImpl = globalThis.fetch) {
  const response = await fetchImpl(request.url, {
    method: request.method,
    headers: request.headers,
    body: JSON.stringify(request.body),
  });
  return {
    status: response.status,
    bodyText: await response.text(),
  };
}
