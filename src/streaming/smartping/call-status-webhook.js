import { createHash } from 'node:crypto';
import { timingSafeEqual } from 'node:crypto';
import { logStreamEvent } from '../stream-logger.js';

const PHONE_LIKE_KEYS = new Set([
  'phone',
  'phone_number',
  'phonenumber',
  'mobile',
  'msisdn',
  'did',
  'did_number',
  'from',
  'to',
  'caller',
  'callee',
]);

function secretsMatch(actual, expected) {
  const actualBuffer = Buffer.from(actual ?? '');
  const expectedBuffer = Buffer.from(expected ?? '');
  return (
    actualBuffer.length === expectedBuffer.length &&
    timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

function pickString(obj, keys) {
  for (const key of keys) {
    const value = obj?.[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return null;
}

function hashOpaque(value) {
  if (!value) return null;
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
}

function findPhoneLikeValues(value, found = []) {
  if (!value || typeof value !== 'object') return found;
  if (Array.isArray(value)) {
    for (const entry of value) findPhoneLikeValues(entry, found);
    return found;
  }
  for (const [key, nested] of Object.entries(value)) {
    if (PHONE_LIKE_KEYS.has(String(key).toLowerCase()) && nested != null) {
      found.push(String(nested));
    } else if (nested && typeof nested === 'object') {
      findPhoneLikeValues(nested, found);
    }
  }
  return found;
}

/**
 * Safe adapter boundary for SmartPing call-status webhooks.
 * Exact field schema is not fully documented — only extract optional
 * identifiers when present; never invent required SmartPing fields.
 */
export function normalizeCallStatusPayload(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw Object.assign(new Error('Webhook body must be a JSON object'), {
      statusCode: 400,
      code: 'invalid_body',
    });
  }

  const callRef = pickString(body, [
    'call_id',
    'callId',
    'call_sid',
    'callSid',
    'stream_sid',
    'streamSid',
  ]);
  const eventId = pickString(body, [
    'event_id',
    'eventId',
    'id',
    'uuid',
    'message_id',
    'messageId',
  ]);
  const status = pickString(body, [
    'status',
    'call_status',
    'callStatus',
    'event',
    'state',
  ]);

  const phoneCandidates = findPhoneLikeValues(body);
  const phoneHash = phoneCandidates.length
    ? hashOpaque(phoneCandidates[0])
    : null;

  const eventKey =
    eventId ||
    (callRef && status ? `${callRef}:${status}` : null) ||
    hashOpaque(JSON.stringify(Object.keys(body).sort()));

  return {
    eventKey,
    callRef,
    eventId,
    status,
    phoneHash,
    fieldKeys: Object.keys(body).slice(0, 32),
    schemaDependency:
      'Exact SmartPing call-status webhook field names remain undocumented; adapter stores only optional identifiers when present.',
  };
}

export function authorizeCallStatusWebhook(request, config) {
  const mode = config.webhookAuthMode ?? 'validation-only';

  if (mode === 'disabled' || mode === 'validation-only') {
    return { ok: true, auth: 'accepted', authReason: mode };
  }

  if (mode === 'shared-secret') {
    if (!config.webhookSharedSecret) {
      return {
        ok: false,
        statusCode: 503,
        auth: 'rejected',
        authReason: 'misconfigured',
        message: 'Webhook shared secret is not configured',
      };
    }
    const provided =
      request.headers?.['x-smartping-webhook-secret'] ??
      request.headers?.['x-webhook-secret'] ??
      '';
    if (!secretsMatch(String(provided), config.webhookSharedSecret)) {
      return {
        ok: false,
        statusCode: 401,
        auth: 'rejected',
        authReason: 'invalid',
        message: 'Invalid webhook secret',
      };
    }
    return { ok: true, auth: 'accepted', authReason: 'shared_secret' };
  }

  return {
    ok: false,
    statusCode: 503,
    auth: 'rejected',
    authReason: 'misconfigured',
    message: 'Unknown webhook auth mode',
  };
}

/**
 * Simple fixed-window rate limiter (per process).
 */
export function createRateLimiter({ limitPerMinute = 60 } = {}) {
  const hits = new Map();

  return {
    check(key) {
      const now = Date.now();
      const windowMs = 60_000;
      const bucket = hits.get(key);
      if (!bucket || now - bucket.windowStart >= windowMs) {
        hits.set(key, { windowStart: now, count: 1 });
        return { ok: true, remaining: limitPerMinute - 1 };
      }
      if (bucket.count >= limitPerMinute) {
        return { ok: false, remaining: 0 };
      }
      bucket.count += 1;
      return { ok: true, remaining: limitPerMinute - bucket.count };
    },
    clear() {
      hits.clear();
    },
  };
}

export function logWebhookEvent(fields, sink = console.log) {
  logStreamEvent(
    {
      event: fields.event,
      route: fields.route,
      auth: fields.auth,
      authReason: fields.authReason,
      connectionId: fields.eventKeyHash ?? undefined,
      validationError: fields.validationError,
      protocolEvent: undefined,
    },
    sink,
  );
}

export function hashEventKey(eventKey) {
  return hashOpaque(eventKey);
}
