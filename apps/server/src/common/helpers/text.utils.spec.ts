import { collapseBlankLines } from './text.utils';

describe('collapseBlankLines', () => {
  it.each([
    ['a\n\n\n\nb', 'a\n\nb'],
    ['a\n\nb', 'a\n\nb'],
    ['a\nb', 'a\nb'],
    ['\n\n\n\na\n\n\n', '\n\na\n\n'],
    ['no newlines', 'no newlines'],
    ['', ''],
  ])('collapses %j to %j', (input, expected) => {
    expect(collapseBlankLines(input)).toBe(expected);
  });
});

import {
  containsCjk,
  escapeLike,
  buildSnippetHighlight,
} from './text.utils';

describe('containsCjk', () => {
  it.each([
    ['안녕하세요', true],
    ['휴가', true],
    ['こんにちは', true],
    ['你好', true],
    ['hello world', false],
    ['vacation policy 2026', false],
    ['', false],
  ])('containsCjk(%j) === %s', (input, expected) => {
    expect(containsCjk(input)).toBe(expected);
  });
});

describe('escapeLike', () => {
  it('escapes LIKE wildcards and backslash', () => {
    expect(escapeLike('100%')).toBe('100\\%');
    expect(escapeLike('a_b')).toBe('a\\_b');
    expect(escapeLike('a\\b')).toBe('a\\\\b');
    expect(escapeLike('plain')).toBe('plain');
  });
});

describe('buildSnippetHighlight', () => {
  it('wraps matches in <b>', () => {
    expect(buildSnippetHighlight('휴가 신청 절차 안내', '휴가')).toBe(
      '<b>휴가</b> 신청 절차 안내',
    );
  });

  it('HTML-escapes attacker-controlled content before wrapping', () => {
    const out = buildSnippetHighlight(
      '보안 <img src=x onerror=alert(1)> 테스트',
      '테스트',
    );
    expect(out).not.toContain('<img');
    expect(out).toContain('&lt;img');
    expect(out).toContain('<b>테스트</b>');
  });

  it('escapes the query itself', () => {
    const out = buildSnippetHighlight('a <script> b', '<script>');
    expect(out).toBe('a <b>&lt;script&gt;</b> b');
  });

  it('windows around the first match in long text', () => {
    const long = 'x'.repeat(500) + ' needle ' + 'y'.repeat(500);
    const out = buildSnippetHighlight(long, 'needle');
    expect(out).toContain('<b>needle</b>');
    expect(out.length).toBeLessThan(400);
  });

  it('returns empty for blank content', () => {
    expect(buildSnippetHighlight('', 'q')).toBe('');
  });
});
