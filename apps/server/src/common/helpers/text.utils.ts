import { htmlEscape } from './html-escaper';

export function collapseBlankLines(text: string): string {
  return text.replace(/\n{2,}/g, '\n\n');
}

// Hangul (jamo + syllables), CJK unified, Japanese kana, CJK compat ideographs
const CJK_RE =
  /[\u1100-\u11FF\u3130-\u318F\uAC00-\uD7AF\u4E00-\u9FFF\u3040-\u30FF\uF900-\uFAFF]/;

/** True when the text contains Korean/Japanese/Chinese characters. */
export function containsCjk(text: string): boolean {
  return CJK_RE.test(text);
}

/** Escape LIKE/ILIKE wildcards and the backslash escape char. */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, '\\$&');
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Window around the first query occurrence with <b>-wrapped matches.
 * The window is HTML-escaped BEFORE wrapping — page text content is
 * attacker-controllable and clients render highlights as HTML.
 */
export function buildSnippetHighlight(
  content: string,
  query: string,
): string {
  const text = (content ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  const needle = query.trim().toLowerCase();
  const idx = needle ? text.toLowerCase().indexOf(needle) : -1;
  const start = idx > 120 ? idx - 120 : 0;
  const window = htmlEscape(text.slice(start, start + 300));
  if (!needle) return window;
  return window.replace(
    new RegExp(escapeRegExp(htmlEscape(query.trim())), 'gi'),
    (m) => `<b>${m}</b>`,
  );
}
