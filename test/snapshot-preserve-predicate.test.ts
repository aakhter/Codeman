// COD-92: after a terminal-snapshot restore, a byte-identical canonical buffer
// must NOT trigger the full clear+rewrite (the visible blank-then-repaint flash
// on tab switch). The decision is extracted as a pure prototype predicate in
// terminal-ui.js so it can be unit-tested here (same vm harness as
// terminal-document-link-provider.test.ts); app.js consumes it at the buffer
// fetch site.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

function loadPrototype() {
  const source = readFileSync(resolve(import.meta.dirname, '../src/web/public/terminal-ui.js'), 'utf8');
  const context = vm.createContext({
    console: { ...console, debug: vi.fn(), log: vi.fn() },
    CodemanApp: class CodemanApp {},
    setInterval: vi.fn(),
    clearInterval: vi.fn(),
    setTimeout,
    clearTimeout,
    requestAnimationFrame: vi.fn(),
    document: { addEventListener: vi.fn(), getElementById: vi.fn(), documentElement: { dataset: {} } },
    window: {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      document: { documentElement: { dataset: {} } },
    },
  });
  vm.runInContext(`${source}\nglobalThis.__proto = CodemanApp.prototype;`, context);
  return (context as unknown as { __proto: Record<string, (...args: never[]) => unknown> }).__proto;
}

const proto = loadPrototype();
type Opts = {
  restoredSnapshot: boolean;
  clearedForBusy: boolean;
  requestFullHistory: boolean;
  canonicalUnchanged: boolean;
  sessionIsBusy: boolean;
  mode: string | undefined;
};
const preserve = (opts: Partial<Opts>) =>
  (proto._shouldPreserveSnapshotScrollback as (o: Partial<Opts>) => boolean).call(proto, opts);

describe('COD-92 _shouldPreserveSnapshotScrollback', () => {
  const base: Opts = {
    restoredSnapshot: true,
    clearedForBusy: false,
    requestFullHistory: false,
    canonicalUnchanged: true,
    sessionIsBusy: false,
    mode: 'claude',
  };

  it('preserves the snapshot for ANY mode when the canonical buffer byte-matches the cache', () => {
    for (const mode of ['claude', 'codex', 'opencode', 'gemini']) {
      expect(preserve({ ...base, mode }), mode).toBe(true);
    }
  });

  it('codex keeps its busy allowance (live output will reconcile the viewport)', () => {
    expect(preserve({ ...base, mode: 'codex', canonicalUnchanged: false, sessionIsBusy: true })).toBe(true);
  });

  it('non-codex modes do NOT get the busy allowance — a changed buffer must rewrite', () => {
    for (const mode of ['claude', 'opencode', 'gemini']) {
      expect(preserve({ ...base, mode, canonicalUnchanged: false, sessionIsBusy: true }), mode).toBe(false);
    }
  });

  it('a changed canonical buffer on an idle session always rewrites (COD-175: idle tabs must learn about missed output)', () => {
    expect(preserve({ ...base, canonicalUnchanged: false })).toBe(false);
  });

  it('never preserves without a restored snapshot', () => {
    expect(preserve({ ...base, restoredSnapshot: false })).toBe(false);
  });

  it('never preserves when the terminal was already cleared for a busy/mirror paint', () => {
    expect(preserve({ ...base, clearedForBusy: true })).toBe(false);
  });

  it('never preserves on the first full-history load after page open', () => {
    expect(preserve({ ...base, requestFullHistory: true })).toBe(false);
  });
});

describe('COD-92 app.js call-site (static guard)', () => {
  it('the buffer-fetch site delegates to the predicate instead of inlining snapshot logic', () => {
    const appSource = readFileSync(resolve(import.meta.dirname, '../src/web/public/app.js'), 'utf8');
    expect(appSource).toContain('_shouldPreserveSnapshotScrollback(');
  });
});
