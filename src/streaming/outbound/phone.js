import { maskPhone } from '../call-station.js';

export const OUTBOUND_VOICE_OPTIONS = [
  {
    id: 'en-IN-NeerjaNeural',
    label: 'Neerja',
    description: 'Female',
    language: 'en',
    languageLabel: 'English',
    gender: 'female',
  },
  {
    id: 'en-IN-PrabhatNeural',
    label: 'Prabhat',
    description: 'Male',
    language: 'en',
    languageLabel: 'English',
    gender: 'male',
  },
  {
    id: 'te-IN-ShrutiNeural',
    label: 'ప్రియ',
    description: 'Female',
    language: 'te',
    languageLabel: 'Telugu',
    gender: 'female',
  },
  {
    id: 'te-IN-MohanNeural',
    label: 'రవి',
    description: 'Male',
    language: 'te',
    languageLabel: 'Telugu',
    gender: 'male',
  },
];

const ALLOWED_VOICES = new Set(OUTBOUND_VOICE_OPTIONS.map((v) => v.id));

export const OUTBOUND_LANGUAGE_OPTIONS = [
  { id: 'en', label: 'English', hint: 'Indian English' },
  { id: 'te', label: 'Telugu', hint: 'తెలుగు — use Telugu script' },
];

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

export function normalizeOutboundVoice(raw, fallback = 'en-IN-NeerjaNeural') {
  const voice = String(raw ?? '').trim();
  if (ALLOWED_VOICES.has(voice)) {
    return { ok: true, voice };
  }
  if (!voice && ALLOWED_VOICES.has(fallback)) {
    return { ok: true, voice: fallback };
  }
  if (!voice) {
    return { ok: true, voice: 'en-IN-NeerjaNeural' };
  }
  return {
    ok: false,
    voice: null,
    error:
      'Choose an English (Neerja/Prabhat) or Telugu (Shruti/Mohan) voice',
    code: 'invalid_voice',
  };
}

export function voiceMeta(voiceId) {
  return OUTBOUND_VOICE_OPTIONS.find((v) => v.id === voiceId) || null;
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
