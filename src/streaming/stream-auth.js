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

/**
 * Temporary Railway/simulator protection only.
 * This is not a documented SmartPing WebSocket authentication contract.
 */
export function authorizeStreamUpgrade(request, config) {
  if (config.streamAuthMode !== 'required') {
    return { ok: true, mode: 'disabled' };
  }

  if (!config.streamSharedSecret) {
    return {
      ok: false,
      statusCode: 503,
      code: 'stream_auth_misconfigured',
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
      message: 'Stream authentication is misconfigured',
    };
  }

  const token = extractBearerToken(request.headers?.authorization);
  if (!token) {
    return {
      ok: false,
      statusCode: 401,
      code: 'stream_auth_missing',
      message: 'Missing Authorization bearer token',
    };
  }

  if (!secretsMatch(token, config.streamSharedSecret)) {
    return {
      ok: false,
      statusCode: 401,
      code: 'stream_auth_invalid',
      message: 'Invalid stream authentication',
    };
  }

  return { ok: true, mode: 'required' };
}

export function rejectUpgrade(socket, statusCode, message) {
  const reason = String(message || 'Unauthorized').replace(/[^\x20-\x7E]/g, ' ');
  const body = JSON.stringify({ error: reason });
  socket.write(
    `HTTP/1.1 ${statusCode} ${statusCode === 401 ? 'Unauthorized' : 'Service Unavailable'}\r\n` +
      'Content-Type: application/json\r\n' +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      'Connection: close\r\n' +
      '\r\n' +
      body,
  );
  socket.destroy();
}
