export const CONSENT_STATUSES = ['pending', 'granted', 'denied', 'revoked', 'missing'];

export const CAMPAIGN_STATUSES = [
  'draft',
  'scheduled',
  'running',
  'paused',
  'completed',
  'cancelled',
];

export const FOLLOW_UP_TYPES = ['email', 'callback', 'human_agent'];

export const FOLLOW_UP_STATUSES = ['pending', 'completed', 'cancelled', 'failed'];

export const ACTIVE_CALL_STATUSES = ['queued', 'initiated', 'ringing', 'answered'];

export const DEFAULT_KEYPAD_ACTIONS = {
  '1': {
    action: 'interested',
    label: 'Interested',
    followUpType: 'email',
  },
  '2': {
    action: 'callback',
    label: 'Request a callback',
    followUpType: 'callback',
  },
  '3': {
    action: 'not_interested',
    label: 'Not interested',
    followUpType: null,
  },
  '9': {
    action: 'human_agent',
    label: 'Human-agent transfer requested',
    followUpType: 'human_agent',
  },
};

export function normalizeConsentStatus(value, { consentBoolean } = {}) {
  if (typeof consentBoolean === 'boolean') {
    return consentBoolean ? 'granted' : 'pending';
  }
  if (typeof value !== 'string' || value.trim().length === 0) {
    return 'pending';
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === 'missing') return 'pending';
  if (!CONSENT_STATUSES.includes(normalized)) {
    throw Object.assign(new Error('consentStatus is invalid'), { statusCode: 400 });
  }
  return normalized === 'missing' ? 'pending' : normalized;
}

export function hasCallConsent(consentStatus) {
  return consentStatus === 'granted';
}

export function interpretDigit(digit, keypadActions = DEFAULT_KEYPAD_ACTIONS) {
  if (digit === undefined || digit === null || digit === '') return null;
  const key = String(digit);
  const mapping = keypadActions?.[key] ?? DEFAULT_KEYPAD_ACTIONS[key];
  if (!mapping) return `Key ${key}`;
  return mapping.label ?? mapping.action ?? `Key ${key}`;
}
