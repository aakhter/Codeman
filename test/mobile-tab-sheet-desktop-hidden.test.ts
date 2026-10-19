/**
 * @fileoverview COD-527: the phone tab sheet must not render on wide screens.
 *
 * mobile-tabs.js creates `#mobileTabScrim` and `#mobileTabSheet` on EVERY
 * device and appends them to body ("_isEnabled gates visibility, not
 * existence"). Their styles live in mobile.css, which only loads under
 * `(max-width: 1023px)`. Before this fix nothing styled them at >=1024px, so on
 * a desktop or an Android tablet in Chrome's "Desktop site" mode the sheet was
 * an unstyled in-flow block below the app: the document grew to ~2x the
 * viewport, and a touch tap on the Case picker scrolled that stray tab list up
 * under the status bar.
 *
 * The fix is a base `display: none` in styles.css that mobile.css (loaded
 * later, same specificity) overrides. Both halves are pinned here: without the
 * base rule the desktop overflow returns, and without the mobile.css display
 * the phone sheet never shows.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const PUBLIC = join(__dirname, '..', 'src', 'web', 'public');

interface Rule {
  selectors: string[];
  body: string;
}

/** Top-level rules only: anything nested in an at-rule block is skipped. */
function topLevelRules(css: string): Rule[] {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules: Rule[] = [];
  let depth = 0;
  let start = 0;
  let selector = '';
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') {
      if (depth === 0) {
        selector = src.slice(start, i).trim();
        start = i + 1;
      }
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) {
        if (!selector.startsWith('@')) {
          rules.push({ selectors: selector.split(',').map((s) => s.trim()), body: src.slice(start, i) });
        }
        start = i + 1;
      }
    }
  }
  return rules;
}

function displayOf(rules: Rule[], selector: string): string | undefined {
  let value: string | undefined;
  for (const rule of rules) {
    if (!rule.selectors.includes(selector)) continue;
    const m = /(?:^|;|\s)display\s*:\s*([^;!]+)/.exec(rule.body);
    if (m) value = m[1].trim();
  }
  return value;
}

describe('COD-527 phone tab sheet on wide screens', () => {
  const styles = topLevelRules(readFileSync(join(PUBLIC, 'styles.css'), 'utf8'));
  const mobile = topLevelRules(readFileSync(join(PUBLIC, 'mobile.css'), 'utf8'));

  it('mobile.css is still media-gated, which is why styles.css needs the base rule', () => {
    const html = readFileSync(join(PUBLIC, 'index.html'), 'utf8');
    expect(html).toMatch(/<link rel="stylesheet" href="mobile\.css" media="\(max-width: 1023px\)">/);
  });

  for (const selector of ['.mobile-tab-sheet', '.mobile-tab-scrim']) {
    it(`styles.css hides ${selector} outside any media query`, () => {
      expect(displayOf(styles, selector)).toBe('none');
    });

    it(`mobile.css gives ${selector} a visible display`, () => {
      const value = displayOf(mobile, selector);
      expect(value).toBeDefined();
      expect(value).not.toBe('none');
    });
  }
});
