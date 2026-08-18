import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const html = readFileSync(resolve(import.meta.dirname, '../src/web/public/index.html'), 'utf8');
const css = readFileSync(resolve(import.meta.dirname, '../src/web/public/styles.css'), 'utf8');

describe('Session Options modal layout (COD-88)', () => {
  it('gives #sessionOptionsModal the scrollable, height-capped modal-lg treatment', () => {
    // The modal must not use a bare .modal-content: that has no max-height and no
    // scrollable body, so a tall Context tab clips off-screen on tablets. .modal-lg
    // supplies max-height:85vh + flex-column + an overflow-y:auto body.
    const start = html.indexOf('id="sessionOptionsModal"');
    expect(start).toBeGreaterThan(-1);
    const header = html.indexOf('class="modal-header"', start);
    const block = html.slice(start, header);
    expect(block).toMatch(/class="modal-content[^"]*\bmodal-lg\b/);
  });

  it('uses one Context column by default and two only on genuinely wide screens', () => {
    expect(css).toMatch(/#sessionOptionsModal #context-tab\s*{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/s);

    const mediaIdx = css.search(/@media[^{]*min-width:\s*1200px/);
    expect(mediaIdx).toBeGreaterThan(-1);
    const after = css.slice(mediaIdx);
    expect(after).toMatch(/#sessionOptionsModal #context-tab\s*{[^}]*repeat\(2, minmax\(0, 1fr\)\)/s);
  });
});
