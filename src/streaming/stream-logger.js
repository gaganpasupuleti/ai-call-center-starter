import { createHash, randomBytes } from 'node:crypto';

const IP_HASH_SALT =
  process.env.STREAM_LOG_IP_SALT || 'smartping-stream-log-salt-v1';

const RECOGNIZED_PROTOCOL_EVENTS = new Set([
  'connected',
  'start',
  'media',
  'mark',
  'dtmf',
  'clear',
  'hangupCall',
  'transfer',
  'stop',
  'error',
]);

function nowUtc() {
  return new Date().toISOString();
}

export function sanitizeIp(ip) {
  if (!ip || typeof ip !== 'string') {
    return { ipPartial: null, ipHash: null };
  }
  const trimmed = ip.trim();
  let ipPartial = null;
  if (trimmed.includes('.')) {
    const parts = trimmed.split('.');
    if (parts.length === 4) {
      ipPartial = `${parts[0]}.${parts[1]}.x.x`;
    }
  } else if (trimmed.includes(':')) {
    const parts = trimmed.split(':').filter(Boolean);
    ipPartial = parts.length >= 2 ? `${parts[0]}:${parts[1]}::x` : 'ipv6:x';
  }
  const ipHash = createHash('sha256')
    .update(`${IP_HASH_SALT}:${trimmed}`)
    .digest('hex')
    .slice(0, 12);
  return { ipPartial, ipHash };
}

export function classifyUserAgent(userAgent) {
  if (!userAgent || typeof userAgent !== 'string') return 'unknown';
  const ua = userAgent.toLowerCase();
  if (ua.includes('curl/')) return 'curl';
  if (ua.includes('python-requests') || ua.includes('python/')) return 'python';
  if (ua.includes('okhttp') || ua.includes('java/')) return 'java';
  if (ua.includes('go-http') || ua.startsWith('go-')) return 'go';
  if (ua.includes('node') || ua.includes('ws/')) return 'node';
  if (ua.includes('mozilla/') || ua.includes('chrome/') || ua.includes('safari/')) {
    return 'browser';
  }
  return 'other';
}

export function clientIpFromRequest(request) {
  const forwarded = request?.headers?.['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }
  return request?.socket?.remoteAddress ?? null;
}

/**
 * Privacy-safe structured stream log. Never pass tokens, phones, audio, or bodies.
 */
export function logStreamEvent(fields = {}, sink = console.log) {
  const protocolEvent =
    typeof fields.protocolEvent === 'string' &&
    RECOGNIZED_PROTOCOL_EVENTS.has(fields.protocolEvent)
      ? fields.protocolEvent
      : fields.protocolEvent
        ? 'unrecognized'
        : undefined;

  const line = {
    ts: fields.ts ?? nowUtc(),
    event: fields.event,
    route: fields.route ?? null,
    auth: fields.auth ?? undefined,
    authReason: fields.authReason ?? undefined,
    connectionId: fields.connectionId ?? undefined,
    ipHash: fields.ipHash ?? undefined,
    ipPartial: fields.ipPartial ?? undefined,
    ua: fields.ua ?? undefined,
    protocolEvent,
    closeCode: fields.closeCode ?? undefined,
    validationError: fields.validationError ?? undefined,
    activeConnections: fields.activeConnections ?? undefined,
  };

  // Drop undefined keys for compact logs.
  for (const key of Object.keys(line)) {
    if (line[key] === undefined) delete line[key];
  }

  sink(JSON.stringify(line));
}

export function newConnectionId() {
  return randomBytes(8).toString('hex');
}

export { RECOGNIZED_PROTOCOL_EVENTS };
