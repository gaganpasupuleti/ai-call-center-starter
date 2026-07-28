import { timingSafeEqual } from 'node:crypto';

function secretsMatch(actual, expected) {
  const actualBuffer = Buffer.from(actual ?? '');
  const expectedBuffer = Buffer.from(expected ?? '');
  return (
    actualBuffer.length === expectedBuffer.length &&
    timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

export function extractBearerToken(authorizationHeader) {
  if (typeof authorizationHeader !== 'string') return null;
  const match = authorizationHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  return match[1].trim();
}

export const STREAM_AUTH_MODES = new Set([
  'disabled',
  'required',
  'provider-compatible',
]);

/**
 * Temporary Railway/simulator Bearer protection (`required`) or
 * SmartPing-compatible open upgrade on the documented stream path only
 * (`provider-compatible`). Does not enable outbound calls.
 */
export function authorizeStreamUpgrade(request, config) {
  const mode = config.streamAuthMode ?? 'disabled';

  if (mode === 'provider-compatible') {
    return {
      ok: true,
      mode: 'provider-compatible',
      auth: 'accepted',
      authReason: 'provider_compatible',
    };
  }

  if (mode !== 'required') {
    return {
      ok: true,
      mode: 'disabled',
      auth: 'accepted',
      authReason: 'auth_disabled',
    };
  }

  if (!config.streamSharedSecret) {
    return {
      ok: false,
      statusCode: 503,
      code: 'stream_auth_misconfigured',
      auth: 'rejected',
      authReason: 'misconfigured',
      message: 'Stream authentication is required but not configured',
    };
  }

  // Never accept the SmartPing outbound API token as the stream secret.
  if (
    config.apiToken &&
    secretsMatch(config.streamSharedSecret, config.apiToken)
  ) {
    return {
      ok: false,
      statusCode: 503,
      code: 'stream_auth_misconfigured',
      auth: 'rejected',
      authReason: 'misconfigured',
      message: 'Stream authentication is misconfigured',
    };
  }

  const token = extractBearerToken(request.headers?.authorization);
  if (!token) {
    return {
      ok: false,
      statusCode: 401,
      code: 'stream_auth_missing',
      auth: 'rejected',
      authReason: 'missing',
      message: 'Missing Authorization bearer token',
    };
  }

  if (!secretsMatch(token, config.streamSharedSecret)) {
    return {
      ok: false,
      statusCode: 401,
      code: 'stream_auth_invalid',
      auth: 'rejected',
      authReason: 'invalid',
      message: 'Invalid stream authentication',
    };
  }

  return {
    ok: true,
    mode: 'required',
    auth: 'accepted',
    authReason: 'bearer_valid',
  };
}

/**
 * Optional Bearer gate for simulator HTTP stream commands.
 * Independent of WebSocket auth mode so provider-compatible WSS can still
 * protect command APIs when a Railway-only stream secret is configured.
 */
export function authorizeStreamCommand(request, config) {
  if (!config.streamSharedSecret) {
    return {
      ok: false,
      auth: 'rejected',
      authReason: 'misconfigured',
      message: 'Stream command authentication is not configured',
    };
  }

  if (
    config.apiToken &&
    secretsMatch(config.streamSharedSecret, config.apiToken)
  ) {
    return {
      ok: false,
      auth: 'rejected',
      authReason: 'misconfigured',
      message: 'Stream command authentication is misconfigured',
    };
  }

  const token = extractBearerToken(request.headers?.authorization);
  if (!token) {
    return {
      ok: false,
      auth: 'rejected',
      authReason: 'missing',
      message: 'Missing Authorization bearer token',
    };
  }

  if (!secretsMatch(token, config.streamSharedSecret)) {
    return {
      ok: false,
      auth: 'rejected',
      authReason: 'invalid',
      message: 'Invalid stream authentication',
    };
  }

  return { ok: true, auth: 'accepted', authReason: 'bearer_valid' };
}

export function rejectUpgrade(socket, statusCode, message) {
  const reason = String(message || 'Unauthorized').replace(/[^\x20-\x7E]/g, ' ');
  const body = JSON.stringify({ error: reason });
  const statusText =
    statusCode === 401
      ? 'Unauthorized'
      : statusCode === 503
        ? 'Service Unavailable'
        : 'Error';
  socket.write(
    `HTTP/1.1 ${statusCode} ${statusText}\r\n` +
      'Content-Type: application/json\r\n' +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      'Connection: close\r\n' +
      '\r\n' +
      body,
  );
  socket.destroy();
}
