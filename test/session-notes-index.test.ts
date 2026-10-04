import { describe, expect, it } from 'vitest';
import { checklistItems, setChecklistItem } from '../src/session-notes-index.js';

describe('notebook checklist source editing', () => {
  it('ignores fenced examples and preserves original whitespace and line endings', () => {
    const markdown =
      '# Tasks\r\n- [ ] first  \r\n```md\r\n- [ ] example\r\n```\r\n  * [X] done\r\n~~~\r\n- [ ] example\r\n~~~\r\n';
    const items = checklistItems(markdown);
    expect(items.map(({ text, checked, line }) => ({ text, checked, line }))).toEqual([
      { text: 'first  ', checked: false, line: 2 },
      { text: 'done', checked: true, line: 6 },
    ]);
    expect(setChecklistItem(markdown, 2, true)).toBe(markdown.replace('- [ ] first', '- [x] first'));
    expect(() => setChecklistItem(markdown, 4, true)).toThrow();
  });
  it('recognizes empty tasks and keeps code fenced until a matching sufficiently long close', () => {
    const markdown = '````md\n- [ ] example\n```\n- [ ] still example\n`````\n- [ ]\n1. [X] done\n';
    expect(checklistItems(markdown).map(({ line, checked, text }) => ({ line, checked, text }))).toEqual([
      { line: 6, checked: false, text: '' },
      { line: 7, checked: true, text: 'done' },
    ]);
  });
});
