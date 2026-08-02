/**
 * Shared transcript normalization for deterministic intent matching.
 * Preserves Telugu Unicode and meaningful digits; does not mutate the input.
 */

export function normalizeText(input) {
  if (input === null || input === undefined) return '';
  let text = String(input);
  // Lowercase only affects Latin letters; Telugu is unchanged.
  text = text.toLowerCase();
  text = text.trim();
  // Keep letters, combining marks (Telugu vowel signs / virama), digits, spaces.
  text = text.replace(/[^\p{L}\p{M}\p{N}\s]/gu, ' ');
  text = text.replace(/\s+/g, ' ').trim();
  return text;
}

export function tokenize(normalized) {
  if (!normalized) return [];
  return String(normalized)
    .split(' ')
    .map((t) => t.trim())
    .filter(Boolean);
}
