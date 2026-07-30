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
    body: {
      phone_number: '[REDACTED]',
      did_number: request.body?.did_number ? '[REDACTED]' : '',
      url: request.body?.url ?? null,
      channel_vars: {
        custom_parameters: request.body?.channel_vars?.custom_parameters ?? {},
      },
    },
    tokenConfigured: Boolean(request.headers['x-api-token']),
    redactedToken: redactSecret(request.headers['x-api-token']),
    destinationConfigured: Boolean(request.body?.phone_number),
    didConfigured: Boolean(request.body?.did_number),
  };
}

/**
 * Campaign/bulk fail-closed outbound executor.
 * Dry-run never touches the network. Live campaign/bulk calls stay blocked.
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

  if (config.dryRun !== false) {
    return {
      dryRun: true,
      networkRequestMade: false,
      preview: toRedactedRequestPreview(request),
    };
  }

  // Intentionally unused: campaign path must never call the network.
  void fetchImpl;

  throw new SmartPingLiveCallsDisabledError(
    'SmartPing campaign/bulk live voicebot calls remain disabled. Use the single-call CLI after explicit approval.',
  );
}

/**
 * Fail-closed single-call executor for one approved Stage 1 test.
 * Requires liveCallsEnabled + singleCallEnabled + confirm === true and dryRun off.
 * Does not parse undocumented SmartPing response fields.
 */
export async function executeSingleVoicebotCall(
  config,
  {
    phoneNumber,
    didNumber,
    streamUrl,
    customParameters = { app_call_id: 'stage1-single-call' },
    confirm = false,
    fetchImpl = globalThis.fetch,
  },
) {
  if (!phoneNumber) {
    throw Object.assign(new Error('Destination number env is required'), {
      statusCode: 400,
      code: 'destination_missing',
    });
  }

  const request = buildVoicebotCallRequest({
    baseUrl: config.baseUrl,
    outboundPath: config.outboundPath,
    apiToken: config.apiToken,
    phoneNumber,
    didNumber: didNumber ?? config.didNumber,
    streamUrl: streamUrl ?? config.streamUrl,
    customParameters,
  });

  if (config.dryRun !== false) {
    return {
      dryRun: true,
      networkRequestMade: false,
      singleCall: true,
      preview: toRedactedRequestPreview(request),
    };
  }

  if (config.liveCallsEnabled !== true || config.singleCallEnabled !== true) {
    throw new SmartPingLiveCallsDisabledError(
      'Single-call live mode requires SMARTPING_LIVE_CALLS_ENABLED=true and SMARTPING_SINGLE_CALL_ENABLED=true',
    );
  }

  if (confirm !== true) {
    throw new SmartPingLiveCallsDisabledError(
      'Explicit --confirm is required before placing a single SmartPing test call',
    );
  }

  if (!config.apiToken) {
    throw Object.assign(new Error('SMARTPING_API_TOKEN is required for live single-call'), {
      statusCode: 400,
      code: 'api_token_missing',
    });
  }

  const response = await fetchImpl(request.url, {
    method: request.method,
    headers: request.headers,
    body: JSON.stringify(request.body),
  });
  const bodyText = await response.text();

  return {
    dryRun: false,
    networkRequestMade: true,
    singleCall: true,
    httpStatus: response.status,
    responseBodyBytes: Buffer.byteLength(bodyText),
    // Response field schema remains undocumented — do not parse call IDs.
    responseParsePending: true,
    preview: toRedactedRequestPreview(request),
  };
}
