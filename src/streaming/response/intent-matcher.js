import { normalizeText, tokenize } from './normalize-text.js';
import { INTENTS_EN, INTENT_PRIORITY_EN } from './intents.en.js';
import { INTENTS_TE, INTENT_PRIORITY_TE } from './intents.te.js';
import { looksLikeTimeOrDate } from './entity-extractor.js';

const NEGATION_MARKERS = [
  'not',
  'dont',
  "don't",
  'do not',
  'never',
  'no',
  'ledu',
  'vaddu',
  '\u0C32\u0C47\u0C26\u0C41',
  '\u0C15\u0C3E\u0C26\u0C41',
];

/** Map common Faster-Whisper romanization errors onto intent vocabulary. */
export function softenTeluguAsr(text) {
  let t = String(text ?? '');
  const replacements = [
    [/\bpimpin['’]?/gi, 'pampandi'],
    [/\bpampin\b/gi, 'pampandi'],
    [/\bpampendi\b/gi, 'pampandi'],
    [/\bvivarola\b/gi, 'vivaralu'],
    [/\bvarelu\b/gi, 'vivaralu'],
    [/\brepru\w*/gi, 'repu'],
    [/\bpukul\b/gi, 'repu'],
    [/\bpoon\b/gi, 'repu'],
    [/\bcheyenne\b/gi, 'cheyandi'],
    [/\bchan\b/gi, 'cheyandi'],
    [/\bvadim\b/gi, 'vadu'],
    [/\bmalikul\w*/gi, 'malli'],
    [/\bmalik\w*/gi, 'malli'],
    [/\binterest\s+led\b/gi, 'interest ledu'],
    [/\bco-interest\b/gi, 'interest'],
  ];
  for (const [re, to] of replacements) t = t.replace(re, to);
  return t;
}

const TELUGU_RE = /[\u0C00-\u0C7F]/;
const TRANSLIT_HINTS = [
  'undi',
  'ledu',
  'pampandi',
  'cheyandi',
  'cheyakandi',
  'repu',
  'naku',
  'avunu',
  'kadu',
  'matladali',
  'sayankalam',
  'udayam',
  'vivaralu',
  'kalam',
  'entha',
];

export function detectLanguage(text) {
  const raw = text == null ? '' : String(text);
  if (TELUGU_RE.test(raw)) return 'te';
  const normalized = normalizeText(raw);
  const tokens = new Set(tokenize(normalized));
  let hits = 0;
  for (const hint of TRANSLIT_HINTS) {
    if (tokens.has(hint) || normalized.includes(hint)) hits += 1;
  }
  if (hits >= 1 && (tokens.has('naku') || tokens.has('cheyandi') || tokens.has('pampandi') || tokens.has('repu') || tokens.has('malli') || tokens.has('avunu') || tokens.has('ledu') || tokens.has('undi'))) {
    return 'te';
  }
  return 'en';
}

function phraseMatch(normalized, phrases = []) {
  for (const phrase of phrases) {
    const p = normalizeText(phrase);
    if (!p) continue;
    if (normalized === p) {
      return { matched: true, score: 1 };
    }
    // Word-boundary match — avoid "no" matching inside "not".
    const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    const re = new RegExp(`(?:^|\\s)${escaped}(?:\\s|$)`, 'u');
    if (re.test(normalized)) {
      return { matched: true, score: 0.92 };
    }
  }
  return { matched: false, score: 0 };
}

function keywordScore(tokens, requiredGroups = [], optionalKeywords = []) {
  if (!requiredGroups.length) return 0;
  let best = 0;
  for (const group of requiredGroups) {
    const needed = group.map((g) => normalizeText(g)).filter(Boolean);
    if (!needed.length) continue;
    const hits = needed.filter((k) => tokens.includes(k)).length;
    if (hits === needed.length) {
      best = Math.max(best, 0.75 + Math.min(0.2, hits * 0.05));
    } else if (hits > 0 && hits / needed.length >= 0.66) {
      best = Math.max(best, 0.45 * (hits / needed.length));
    }
  }
  if (best <= 0) return 0;
  const optHits = optionalKeywords.filter((k) =>
    tokens.includes(normalizeText(k))
  ).length;
  return Math.min(0.98, best + optHits * 0.02);
}

function hasNegationNearInterest(normalized, tokens) {
  if (
    /\b(not interested|dont want|do not want|don't want|no thank)\b/.test(
      normalized
    )
  ) {
    return true;
  }
  if (normalized.includes('interest ledu') || normalized.includes('\u0C06\u0C38\u0C15\u0C4D\u0C24\u0C3F \u0C32\u0C47\u0C26\u0C41')) {
    return true;
  }
  const interestIdx = tokens.findIndex(
    (t) => t === 'interested' || t === 'interest' || t === 'demo' || t === 'details'
  );
  if (interestIdx < 0) return false;
  const window = tokens.slice(Math.max(0, interestIdx - 3), interestIdx + 1);
  return NEGATION_MARKERS.some((m) => {
    const parts = normalizeText(m).split(' ');
    if (parts.length === 1) return window.includes(parts[0]);
    return normalizeText(window.join(' ')).includes(normalizeText(m));
  });
}

function scoreIntent(intentName, config, normalized, tokens, state) {
  if (config.stateOnly && !config.stateOnly.includes(state)) {
    return null;
  }

  const exact = phraseMatch(normalized, config.phrases);
  let score = exact.score;
  const kw = keywordScore(tokens, config.requiredKeywords, config.optionalKeywords);
  score = Math.max(score, kw);

  if (score < 0.45) return null;

  // Negation protection for INTERESTED / SEND_DETAILS / BOOK_DEMO positives
  if (
    (intentName === 'INTERESTED' ||
      intentName === 'SEND_DETAILS' ||
      intentName === 'BOOK_DEMO') &&
    hasNegationNearInterest(normalized, tokens)
  ) {
    return null;
  }

  return {
    intent: intentName,
    confidence: Number(score.toFixed(3)),
  };
}

export function matchIntent(text, { language = 'en', state = 'waiting_for_initial_response' } = {}) {
  const softened = language === 'te' ? softenTeluguAsr(text) : text;
  const normalized = normalizeText(softened);
  const tokens = tokenize(normalized);

  if (!normalized) {
    return { intent: 'UNKNOWN', confidence: 0, language, normalized };
  }

  const catalog = language === 'te' ? INTENTS_TE : INTENTS_EN;
  const priority = language === 'te' ? INTENT_PRIORITY_TE : INTENT_PRIORITY_EN;

  // State-driven reinterpretation of bare time phrases
  if (
    (state === 'waiting_for_callback_time' || state === 'waiting_for_demo_date') &&
    looksLikeTimeOrDate(normalized)
  ) {
    const forced =
      state === 'waiting_for_callback_time' ? 'CALLBACK_TIME' : 'BOOK_DEMO';
    // Still allow DO_NOT_CALL / NOT_INTERESTED / HUMAN_AGENT to win
    const safety = ['DO_NOT_CALL', 'NOT_INTERESTED', 'HUMAN_AGENT'];
    for (const name of safety) {
      const cfg = catalog[name];
      if (!cfg) continue;
      const hit = scoreIntent(name, cfg, normalized, tokens, state);
      if (hit && hit.confidence >= 0.7) {
        return { ...hit, language, normalized };
      }
    }
    return { intent: forced, confidence: 0.88, language, normalized };
  }

  const candidates = [];
  for (const name of priority) {
    if (name === 'UNKNOWN') continue;
    const cfg = catalog[name];
    if (!cfg) continue;
    const hit = scoreIntent(name, cfg, normalized, tokens, state);
    if (hit) candidates.push(hit);
  }

  if (!candidates.length) {
    return { intent: 'UNKNOWN', confidence: 0, language, normalized };
  }

  // Priority order: first in list among near-top scores wins for safety intents
  candidates.sort((a, b) => {
    const pa = priority.indexOf(a.intent);
    const pb = priority.indexOf(b.intent);
    if (Math.abs(a.confidence - b.confidence) < 0.08) return pa - pb;
    return b.confidence - a.confidence;
  });

  const best = candidates[0];
  return { ...best, language, normalized };
}
