import { normalizeText, tokenize } from './normalize-text.js';

const WORD_HOURS = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
};

/**
 * Lightweight entity extraction (no external NLP libraries).
 */
export function extractEntities(text, { language = 'en' } = {}) {
  const original = text == null ? '' : String(text);
  const normalized = normalizeText(original);
  const tokens = tokenize(normalized);
  const entities = {};

  if (!normalized) return entities;

  // Relative date
  if (
    /\bday after tomorrow\b/.test(normalized) ||
    normalized.includes('\u0C30\u0C47\u0C2A\u0C1F\u0C3F')
  ) {
    entities.relativeDate = 'day_after_tomorrow';
  } else if (
    /\btomorrow\b/.test(normalized) ||
    normalized.includes('\u0C30\u0C47\u0C2A\u0C41') ||
    /\brepu\b/.test(normalized)
  ) {
    entities.relativeDate = 'tomorrow';
  } else if (
    /\btoday\b/.test(normalized) ||
    normalized.includes('\u0C08\u0C30\u0C4B\u0C1C\u0C41') ||
    /\beeruju\b/.test(normalized) ||
    /\bivvala\b/.test(normalized)
  ) {
    entities.relativeDate = 'today';
  }

  // Time-of-day buckets
  let period = null;
  if (
    /\bmorning\b/.test(normalized) ||
    normalized.includes('\u0C09\u0C26\u0C2F\u0C02') ||
    /\budayam\b/.test(normalized)
  ) {
    period = 'morning';
  } else if (
    /\bafternoon\b/.test(normalized) ||
    /\bmadhyahnam\b/.test(normalized)
  ) {
    period = 'afternoon';
  } else if (
    /\bevening\b/.test(normalized) ||
    /\bnight\b/.test(normalized) ||
    normalized.includes('\u0C38\u0C3E\u0C2F\u0C02\u0C24\u0C4D\u0C30\u0C02') ||
    /\bsayankalam\b/.test(normalized)
  ) {
    period = 'evening';
  }

  // Clock time: 6:30 pm, 6 pm, six pm, around six
  let hour = null;
  let minute = 0;
  let meridiem = null;

  const clockMatch = normalized.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/);
  if (clockMatch) {
    hour = Number(clockMatch[1]);
    minute = clockMatch[2] ? Number(clockMatch[2]) : 0;
    if (clockMatch[3]) meridiem = clockMatch[3];
  } else {
    for (const [word, value] of Object.entries(WORD_HOURS)) {
      if (tokens.includes(word)) {
        hour = value;
        break;
      }
    }
    if (/\b(am|pm)\b/.test(normalized)) {
      meridiem = normalized.includes('pm') ? 'pm' : 'am';
    }
  }

  if (/\baround\b/.test(normalized) && hour == null) {
    // "around six" already handled via WORD_HOURS
  }

  if (hour != null) {
    let h24 = hour;
    if (meridiem === 'pm' && hour < 12) h24 = hour + 12;
    if (meridiem === 'am' && hour === 12) h24 = 0;
    if (!meridiem && period === 'evening' && hour < 12) h24 = hour + 12;
    if (!meridiem && period === 'morning' && hour === 12) h24 = 0;
    if (!meridiem && period === 'afternoon' && hour < 12 && hour >= 1) {
      h24 = hour < 7 ? hour + 12 : hour;
    }
    const mm = String(Math.min(59, Math.max(0, minute))).padStart(2, '0');
    const hh = String(Math.min(23, Math.max(0, h24))).padStart(2, '0');
    entities.time24h = `${hh}:${mm}`;
    entities.timeText = buildTimeText(normalized, period, hour, meridiem);
  } else if (period) {
    entities.timeText = period;
    if (period === 'morning') entities.time24h = '10:00';
    if (period === 'afternoon') entities.time24h = '14:00';
    if (period === 'evening') entities.time24h = '18:00';
  }

  const hasTimeSignal =
    entities.relativeDate ||
    entities.time24h ||
    entities.timeText ||
    period ||
    hour != null;

  if (!hasTimeSignal && normalized.length > 0) {
    // Caller said something time-like but we could not parse cleanly.
    if (
      /\b(after|before|around|sometime|lunch|o'?clock)\b/.test(normalized) ||
      language === 'te'
    ) {
      // Only set rawTimeText when there is some temporal cue, or leave empty.
    }
  }

  if (
    !entities.time24h &&
    !entities.relativeDate &&
    /\b(sometime|after lunch|before noon)\b/.test(normalized)
  ) {
    entities.rawTimeText = original.trim() || normalized;
  }

  return entities;
}

function buildTimeText(normalized, period, hour, meridiem) {
  const parts = [];
  if (hour != null) {
    parts.push(String(hour));
    if (meridiem) parts.push(meridiem);
  }
  if (period) parts.push(period);
  if (parts.length) return parts.join(' ');
  return normalized;
}

export function looksLikeTimeOrDate(text) {
  const normalized = normalizeText(text);
  if (!normalized) return false;
  if (
    /\b(today|tomorrow|morning|afternoon|evening|night|am|pm|\d{1,2}(?::\d{2})?)\b/.test(
      normalized
    )
  ) {
    return true;
  }
  if (
    /\b(repu|udayam|sayankalam|eeruju|ivvala)\b/.test(normalized) ||
    /[\u0C00-\u0C7F]/.test(normalized)
  ) {
    // Telugu script or transliteration — treat as possible time when in time-collect states
    return (
      normalized.includes('\u0C30\u0C47\u0C2A\u0C41') ||
      normalized.includes('\u0C38\u0C3E\u0C2F\u0C02\u0C24\u0C4D\u0C30\u0C02') ||
      normalized.includes('\u0C09\u0C26\u0C2F\u0C02') ||
      /\b(repu|udayam|sayankalam)\b/.test(normalized) ||
      /\b(six|seven|eight|nine|ten|eleven|twelve|\d)\b/.test(normalized)
    );
  }
  return false;
}
