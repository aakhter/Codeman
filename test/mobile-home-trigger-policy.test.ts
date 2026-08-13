// Port: none (pure static analysis — runs in CI, no browser/server).
//
// Regression guard for COD-290: "the phone home button is hidden, so the mobile
// overview is unreachable from inside a session".
//
// What shipped: mobile.css hid `.header-brand` outright at the phone breakpoint
// (dd57759d, COD-283, "restore phone layout after viewport fix"). Nothing looked
// broken — the overview still rendered on every OTHER showWelcome() path (closing
// the last session, settings apply with no active session), so the feature
// "worked". What was gone was the only way to REACH it while a session is open,
// because `app.goHome()` has exactly one trigger in the entire frontend.
//
// That is why this is a static parser rather than a browser test: the failure was
// invisible to behavioural assertions (the handler was fine, the panel was fine)
// and the real-browser suite that could have caught it (test/mobile/**) is
// EXCLUDED from CI, so it never gated.
//
// Policy, in two parts:
//   1. `app.goHome()` keeps at least one trigger in index.html.
//   2. No @media rule that applies at phone width may `display: none` the trigger
//      or any ancestor it hangs off. Hiding a DESCENDANT is fine and expected —
//      the phone deliberately hides the "Codeman" wordmark and shows the compact
//      "C" inside the same button.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import postcss from 'postcss';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC = join(HERE, '../src/web/public');

// Canonical phone width, matching the device test/mobile emulates (iPhone 14 Pro).
const PHONE_WIDTH = 393;

/** Does this media query's width range include a phone-width viewport? */
function appliesToPhone(params: string): boolean {
  const max = params.match(/max-width:\s*(\d+)px/);
  const min = params.match(/min-width:\s*(\d+)px/);
  if (max && PHONE_WIDTH > Number(max[1])) return false;
  if (min && PHONE_WIDTH < Number(min[1])) return false;
  return Boolean(max || min);
}

/**
 * Classes on the goHome trigger and on every ancestor element that encloses it.
 *
 * Walked by scanning backwards from the trigger and tracking tag depth, so it
 * survives the markup being re-indented or re-wrapped.
 */
function homeTriggerChain(html: string): { classes: Set<string>; triggers: number } {
  const triggers = [...html.matchAll(/onclick="app\.goHome\(\)"/g)].length;
  const at = html.indexOf('onclick="app.goHome()"');
  if (at < 0) return { classes: new Set(), triggers };

  const classes = new Set<string>();
  const own = html.lastIndexOf('<', at);
  for (const c of (html.slice(own, at).match(/class="([^"]*)"/)?.[1] ?? '').split(/\s+/)) {
    if (c) classes.add(c);
  }

  // Walk outwards: every unmatched opening tag before the trigger is an ancestor.
  let depth = 0;
  const before = html.slice(0, own);
  const tags = [...before.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9-]*)\b([^>]*)>/g)].reverse();
  for (const t of tags) {
    const closing = t[1] === '/';
    const selfClosing = t[3].trimEnd().endsWith('/');
    if (selfClosing) continue;
    if (closing) {
      depth++;
      continue;
    }
    if (depth > 0) {
      depth--;
      continue;
    }
    for (const c of (t[3].match(/class="([^"]*)"/)?.[1] ?? '').split(/\s+/)) {
      if (c) classes.add(c);
    }
    if (t[2].toLowerCase() === 'body') break;
  }
  return { classes, triggers };
}

/** Selectors that `display: none` inside a media query applying at phone width. */
function phoneHiddenSelectors(css: string): string[] {
  const out: string[] = [];
  postcss.parse(css).walkAtRules('media', (atRule) => {
    if (!appliesToPhone(atRule.params)) return;
    atRule.walkRules((rule) => {
      let hides = false;
      rule.walkDecls('display', (decl) => {
        if (decl.value.replace(/!important/i, '').trim() === 'none') hides = true;
      });
      if (hides) out.push(...rule.selectors);
    });
  });
  return out;
}

describe('COD-290 phone home-screen trigger stays reachable', () => {
  const html = readFileSync(join(PUBLIC, 'index.html'), 'utf-8');
  const css = readFileSync(join(PUBLIC, 'mobile.css'), 'utf-8');

  it('keeps at least one app.goHome() trigger in the markup', () => {
    const { triggers } = homeTriggerChain(html);
    expect(triggers, 'app.goHome() has no trigger — the overview becomes unreachable').toBeGreaterThan(0);
  });

  it('never hides the trigger or an ancestor at the phone breakpoint', () => {
    const { classes } = homeTriggerChain(html);
    expect(classes.size).toBeGreaterThan(0);

    // A selector can only hide the trigger if EVERY class it names is on the
    // trigger or one of its ancestors. A selector naming a descendant class
    // (.logo-text, the wordmark) is deliberately allowed.
    const offenders = phoneHiddenSelectors(css).filter((sel) => {
      const named = [...sel.matchAll(/\.([A-Za-z0-9_-]+)/g)].map((m) => m[1]);
      return named.length > 0 && named.every((c) => classes.has(c));
    });

    expect(
      offenders,
      `these phone rules display:none the app.goHome() trigger (or an ancestor of it), which is ` +
        `its ONLY entry point: ${offenders.join(', ')}`
    ).toEqual([]);
  });
});
