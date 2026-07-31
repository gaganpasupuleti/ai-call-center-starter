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
  {
    id: 'te',
    label: 'Telugu',
    hint: 'Type in తెలుగు script — English letters sound English',
  },
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

export const DEFAULT_INTERACTIVE_MENU = {
  en: {
    promptSuffix:
      ' Press 1 if you are interested. Press 2 for a callback. Press 9 to speak with an agent.',
    responses: {
      '1': 'Thank you! We have noted that you are interested. Have a wonderful day!',
      '2': 'Got it. We will call you back soon. Thank you!',
      '9': 'Please hold while we connect you with an agent. Thank you for calling!',
      default:
        'Sorry, I did not catch that. Please press 1 if interested, 2 for a callback, or 9 for an agent.',
    },
  },
  te: {
    promptSuffix:
      ' మీరు ఆసక్తి ఉంటే 1 నొక్కండి. కాల్‌బ్యాక్ కావాలంటే 2 నొక్కండి. ఏజెంట్‌తో మాట్లాడాలంటే 9 నొక్కండి.',
    responses: {
      '1': 'ధన్యవాదాలు! మీ ఆసక్తిని నమోదు చేసుకున్నాం. మీ రోజు అద్భుతంగా సాగాలి!',
      '2': 'సరే! మేము త్వరలో మీకు తిరిగి కాల్ చేస్తాము. ధన్యవాదాలు!',
      '9': 'దయచేసి వేచి ఉండండి, మిమ్మల్ని ఏజెంట్‌కు కలుపుతున్నాం. కాల్ చేసినందుకు ధన్యవాదాలు!',
      default:
        'క్షమించండి, అర్థం కాలేదు. ఆసక్తి ఉంటే 1, కాల్‌బ్యాక్ కావాలంటే 2, ఏజెంట్ కావాలంటే 9 నొక్కండి.',
    },
  },
};

export function interactiveLanguageForVoice(voiceId) {
  return voiceMeta(voiceId)?.language === 'te' ? 'te' : 'en';
}

export function buildInteractivePromptText(messageText, { interactive, voice }) {
  const text = String(messageText ?? '').trim();
  if (!interactive) return text;
  const lang = interactiveLanguageForVoice(voice);
  const suffix = DEFAULT_INTERACTIVE_MENU[lang].promptSuffix;
  if (text.includes(suffix.trim())) return text;
  return `${text}${suffix}`.slice(0, 500);
}

export function normalizeInteractiveMenu({ interactive, voice, menu } = {}) {
  if (interactive !== true) {
    return { ok: true, interactive: false, menu: null };
  }
  const lang = interactiveLanguageForVoice(voice);
  const defaults = DEFAULT_INTERACTIVE_MENU[lang];
  const incoming = menu && typeof menu === 'object' ? menu : {};
  const responses = {
    '1': String(incoming['1'] ?? defaults.responses['1']).trim().slice(0, 500),
    '2': String(incoming['2'] ?? defaults.responses['2']).trim().slice(0, 500),
    '9': String(incoming['9'] ?? defaults.responses['9']).trim().slice(0, 500),
    default: String(incoming.default ?? defaults.responses.default)
      .trim()
      .slice(0, 500),
  };
  for (const [digit, text] of Object.entries(responses)) {
    if (!text) {
      return {
        ok: false,
        interactive: false,
        menu: null,
        error: `Interactive response for ${digit} is required`,
        code: 'interactive_response_required',
      };
    }
  }
  return {
    ok: true,
    interactive: true,
    language: lang,
    promptSuffix: defaults.promptSuffix,
    menu: responses,
  };
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
