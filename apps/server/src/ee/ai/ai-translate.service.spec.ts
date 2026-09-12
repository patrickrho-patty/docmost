import { AiTranslateService } from './ai-translate.service';

/**
 * Derivation lock for the translation version key.
 *
 * The version key (sourceHash) joins three parties that must always agree:
 * the requesting client's live-DOM derivation, every other viewer's status
 * poll derivation, and this server-side derivation from the received blocks'
 * HTML. If hashBlocks drifts from the client's computeSourceHash /
 * normalizeBlockText (use-page-translate.ts), viewers stop finding each
 * other's jobs and every press starts a fresh translation — the exact
 * regression this spec exists to catch. Expected values below are locked;
 * regenerate them only together with the client derivation.
 */
describe('AiTranslateService.hashBlocks (version-key derivation)', () => {
  const service = new AiTranslateService(null, null, null);
  const hash = (blocks: { id: number; html: string }[]): string =>
    (service as any).hashBlocks(blocks);

  it('extracts text through marks, links, and mentions', () => {
    expect(
      hash([
        {
          id: 0,
          html: '<p><strong>Company</strong> <em>values</em> and <code>integrity</code></p>',
        },
        {
          id: 1,
          html: '<p>See <a href="https://example.com/handbook">the handbook</a> for details</p>',
        },
        {
          id: 2,
          html: '<p>Owner: <span class="mention" data-id="u1">@Minji</span> reviews this</p>',
        },
      ]),
    ).toBe('fb9c1eb31d84711de4686e5d0d92678f7f890b9e47987e0ded198334e9792db8');
  });

  it('collapses entities and whitespace like DOM textContent does', () => {
    expect(
      hash([
        { id: 0, html: '<p>Line&nbsp;breaks&nbsp;stay   as    spaces</p>' },
        { id: 1, html: '<p>First line<br>Second line</p>' },
        { id: 2, html: '<p>Emoji 🚀 and unicode ©™ pass through</p>' },
      ]),
    ).toBe('157caa89adcda8eaf49df518d39e39ced853a433137fb44ceab38d16acdfa154');
  });

  it('keeps selection-wrapped text and handles Korean', () => {
    expect(
      hash([
        {
          id: 0,
          html: '<p>Selected <span class="ProseMirror-yjs-selection">keep me</span> survives hashing</p>',
        },
        {
          id: 1,
          html: '<p>한국어 원문 <span class="collaboration-carets__selection">텍스트</span>도 동일하게</p>',
        },
      ]),
    ).toBe('5f13e050c44183ff30cdfa308b4706b2af85a768202c3bbbbcf98bd20fd9d9af');
  });

  it('is deterministic, content-sensitive, and order-sensitive', () => {
    const blocks = [
      { id: 0, html: '<p>Alpha</p>' },
      { id: 1, html: '<p>Beta</p>' },
    ];
    const base = hash(blocks);
    expect(hash(blocks.map((b) => ({ ...b })))).toBe(base);
    expect(hash([{ id: 0, html: '<p>Alpha!</p>' }, blocks[1]])).not.toBe(base);
    expect(hash([blocks[1], blocks[0]])).not.toBe(base);
  });
});
