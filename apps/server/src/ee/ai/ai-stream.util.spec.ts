import { ThinkTagFilter } from './ai-stream.util';

describe('ThinkTagFilter', () => {
  it('passes through plain text', () => {
    const f = new ThinkTagFilter();
    expect(f.push('hello world')).toBe('hello world');
    expect(f.flush()).toBe('');
  });

  it('strips a complete think block in one push', () => {
    const f = new ThinkTagFilter();
    expect(f.push('before<think>secret reasoning</think>after')).toBe(
      'beforeafter',
    );
  });

  it('strips think blocks split across pushes', () => {
    const f = new ThinkTagFilter();
    const parts = ['ans<th', 'ink>chain', ' of thought</thi', 'nk>wer'];
    const out = parts.map((p) => f.push(p)).join('') + f.flush();
    expect(out).toBe('answer');
  });

  it('holds back a partial opening tag at chunk end', () => {
    const f = new ThinkTagFilter();
    expect(f.push('visible<thi')).toBe('visible');
    expect(f.push('nk>hidden')).toBe('');
    expect(f.push('</think>shown')).toBe('shown');
  });

  it('drops an unterminated think block on flush', () => {
    const f = new ThinkTagFilter();
    f.push('start<think>never closed');
    expect(f.flush()).toBe('');
  });

  it('keeps text when only a partial tag remains at flush', () => {
    const f = new ThinkTagFilter();
    const streamed = f.push('almost<th');
    // push holds back the potential tag prefix; flush releases it
    expect(streamed + f.flush()).toBe('almost<th');
  });

  it('handles multiple think blocks', () => {
    const f = new ThinkTagFilter();
    const out =
      f.push('a<think>x</think>b') + f.push('<think>y</think>c') + f.flush();
    expect(out).toBe('abc');
  });
});
