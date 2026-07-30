import { maskPhone } from '../call-station.js';

/**
 * SmartPing email cURL uses 10-digit Indian mobiles (no + / no 91 prefix).
 */
export function normalizeOutboundPhone(raw) {
  const digits = String(raw ?? '').replace(/\D/g, '');
  if (/^91\d{10}$/.test(digits)) {
    return {
      ok: true,
      phone: digits.slice(2),
      normalizedFrom: '91_prefix',
      masked: maskPhone(digits.slice(2)),
    };
  }
  if (/^\d{10}$/.test(digits)) {
    return {
      ok: true,
      phone: digits,
      normalizedFrom: '10_digits',
      masked: maskPhone(digits),
    };
  }
  return {
    ok: false,
    phone: null,
    error: 'Phone must be 10 digits (or 91 + 10 digits)',
    code: 'invalid_phone',
    masked: maskPhone(digits),
  };
}

export function normalizeRepeatCount(value, fallback = 1) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(5, Math.round(n)));
}

export function normalizeOutboundMessage(raw) {
  const text = String(raw ?? '').trim();
  if (!text) {
    return { ok: false, text: '', error: 'Message is required', code: 'message_required' };
  }
  if (text.length > 500) {
    return {
      ok: false,
      text: '',
      error: 'Message must be 500 characters or fewer',
      code: 'message_too_long',
    };
  }
  return { ok: true, text, length: text.length };
}
