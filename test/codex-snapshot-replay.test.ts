import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

// Structural tests for the xterm snapshot/replay slice (COD-81). app.js has no
// bundler and is hard to drive through a real DOM, so — following the repo's
// existing pattern for app.js — these assert the source structure that makes
// the snapshot first-paint correct rather than executing it.
//
// COD-92 extracted the actual preserve-or-rewrite decision into a pure
// predicate (`_shouldPreserveSnapshotScrollback`, terminal-ui.js) that is
// mode-agnostic. Where a test below is really about THAT decision, it loads
// the predicate through this same vm harness used by
// test/snapshot-preserve-predicate.test.ts and asserts behaviour directly,
// rather than pinning source substrings that are specific to one CLI mode.
function loadPreservePredicate() {
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
  const proto = (context as unknown as { __proto: Record<string, (...args: never[]) => unknown> }).__proto;
  return (opts: Record<string, unknown>) => proto._shouldPreserveSnapshotScrollback.call(proto, opts);
}

describe('xterm snapshot/replay (codex tab-switch)', () => {
  const appSource = () => readFileSync(resolve(import.meta.dirname, '../src/web/public/app.js'), 'utf8');

  it('rejects blank xterm snapshots before saving or restoring them', () => {
    const source = appSource();
    const helper = source.indexOf('_isUsableXtermSnapshot(snapshot)');
    const save = source.indexOf('this._xtermSnapshots.set(this.activeSessionId, snapshot)');
    const restore = source.indexOf('SNAPSHOT_RESTORE:', save);
    const restoreBlock = source.slice(save, restore);

    expect(helper).toBeGreaterThan(-1);
    // The save is gated on a usability check immediately above it.
    const usabilityGate = source.lastIndexOf('if (this._isUsableXtermSnapshot(snapshot))', save);
    expect(usabilityGate).toBeGreaterThan(-1);
    expect(usabilityGate).toBeLessThan(save);
    // …and so is each restore path (in-memory + persisted).
    expect(restoreBlock).toContain('if (snapshot && !this._isUsableXtermSnapshot(snapshot))');
    expect(restoreBlock).toContain('persisted && this._isUsableXtermSnapshot(persisted)');
  });

  it('declares the snapshot-restore flag before selectSession uses it', () => {
    const source = appSource();
    const selectStart = source.indexOf('async selectSession(sessionId, options = {})');
    const declaration = source.indexOf('let restoredSnapshot = false;', selectStart);
    const snapshotBranch = source.indexOf(
      "if (snapshot && session?.mode !== 'shell' && (!sessionIsBusy || session?.mode === 'codex'))",
      selectStart
    );
    const rewriteDecision = source.indexOf('const preserveSnapshotScrollback', selectStart);

    expect(selectStart).toBeGreaterThan(-1);
    expect(declaration).toBeGreaterThan(selectStart);
    expect(declaration).toBeLessThan(snapshotBranch);
    expect(declaration).toBeLessThan(rewriteDecision);
  });

  it('uses xterm snapshots as first paint but still fetches the canonical terminal frame', () => {
    const source = appSource();
    const snapshotRestore = source.indexOf('SNAPSHOT_RESTORE:');
    const cacheRestore = source.indexOf('Instant cache restore', snapshotRestore);
    const fetchStart = source.indexOf("FETCH_START'", snapshotRestore);
    const needsRewrite = source.indexOf('const needsRewrite', fetchStart);
    const snapshotBlock = source.slice(snapshotRestore, cacheRestore);
    const postSnapshotRestore = source.slice(snapshotRestore, needsRewrite + 160);

    expect(snapshotRestore).toBeGreaterThan(-1);
    expect(cacheRestore).toBeGreaterThan(snapshotRestore);
    expect(fetchStart).toBeGreaterThan(cacheRestore);
    expect(needsRewrite).toBeGreaterThan(fetchStart);
    // Snapshot restore must NOT short-circuit the canonical fetch.
    expect(snapshotBlock).not.toContain('this._finishBufferLoad();');
    expect(postSnapshotRestore).toContain('restoredSnapshot');
    expect(postSnapshotRestore).toContain('preserveSnapshotScrollback');
  });

  it('fetches full Codex history the first time a session is loaded after page open', () => {
    const source = appSource();
    const constructorState = source.indexOf('this._sessionsLoadedSincePageOpen = new Set()');
    const selectStart = source.indexOf('async selectSession(sessionId, options = {})');
    const fetchStart = source.indexOf("_crashDiag.log('FETCH_START')", selectStart);
    const fetchBlock = source.slice(fetchStart, source.indexOf('const res = await fetch(terminalUrl);', fetchStart));

    expect(constructorState).toBeGreaterThan(-1);
    expect(fetchStart).toBeGreaterThan(selectStart);
    // Upstream #205 replaced the per-page-open flag with a per-session Set and
    // an explicit ?full=1; the invariant (first load of each session this page
    // load gets the FULL tmux scrollback) is unchanged.
    expect(fetchBlock).toContain('const useFullHistory');
    expect(fetchBlock).toContain('!this._fullHistoryLoaded.has(sessionId)');
    expect(fetchBlock).toContain('`/api/sessions/${sessionId}/terminal?full=1`');
    expect(fetchBlock).toContain('`/api/sessions/${sessionId}/terminal?tail=${TERMINAL_TAIL_SIZE}`');
    expect(fetchBlock).toContain('this._sessionsLoadedSincePageOpen.add(sessionId)');
  });

  it('does not preserve a restored Codex snapshot over a full-history replay', () => {
    const source = appSource();
    const selectStart = source.indexOf('async selectSession(sessionId, options = {})');
    const fullHistoryDecision = source.indexOf('const useFullHistory', selectStart);
    const preserveDecision = source.indexOf('const preserveSnapshotScrollback', fullHistoryDecision);
    const rewriteDecision = source.indexOf('const needsRewrite', preserveDecision);
    const block = source.slice(fullHistoryDecision, rewriteDecision + 220);

    expect(fullHistoryDecision).toBeGreaterThan(selectStart);
    expect(preserveDecision).toBeGreaterThan(fullHistoryDecision);
    // The call site forwards requestFullHistory into the extracted predicate
    // (COD-92) rather than inlining a `!requestFullHistory` guard itself.
    expect(block).toContain('requestFullHistory: useFullHistory,');
    expect(block).toContain('preserveSnapshotScrollback');

    // Behavioural: a full-history replay must win even for a busy codex
    // session whose canonical buffer byte-matches the cache — every other
    // condition that would otherwise preserve the restored snapshot.
    const preserve = loadPreservePredicate();
    expect(
      preserve({
        restoredSnapshot: true,
        clearedForBusy: false,
        requestFullHistory: true,
        canonicalUnchanged: true,
        sessionIsBusy: true,
        mode: 'codex',
      })
    ).toBe(false);
  });

  it('never preserves a stale snapshot over changed canonical output (COD-175)', () => {
    const source = appSource();
    const selectStart = source.indexOf('async selectSession(sessionId, options = {})');
    const preserveDecision = source.indexOf('const preserveSnapshotScrollback', selectStart);
    const rewriteDecision = source.indexOf('const needsRewrite', preserveDecision);
    const block = source.slice(preserveDecision, rewriteDecision);

    expect(preserveDecision).toBeGreaterThan(selectStart);
    // Preserve is only allowed when nothing new happened since the cached
    // canonical buffer, or while live output is still streaming (busy) to
    // reconcile the viewport. Otherwise the fetched frame must be replayed —
    // an idle codex tab frozen on "Working (31" was caused by preserving
    // unconditionally while the fetch that contained the finished response
    // was discarded.
    expect(block).toContain('canonicalUnchanged');
    expect(block).toContain('sessionIsBusy');
    const canonicalDecl = source.indexOf('const canonicalUnchanged', selectStart);
    expect(canonicalDecl).toBeGreaterThan(selectStart);
    expect(canonicalDecl).toBeLessThan(rewriteDecision);
    expect(source.slice(canonicalDecl, canonicalDecl + 120)).toContain('data.terminalBuffer === cachedBuffer');
  });

  it('restores Codex snapshots even while the session is busy', () => {
    const source = appSource();
    const selectStart = source.indexOf('async selectSession(sessionId, options = {})');
    const sessionIsBusy = source.indexOf('const sessionIsBusy', selectStart);
    const snapshotBranch = source.indexOf('if (snapshot && session?.mode !==', sessionIsBusy);
    const busyClear = source.indexOf('CACHE_SKIP_BUSY', snapshotBranch);
    const block = source.slice(sessionIsBusy, busyClear + 120);

    expect(sessionIsBusy).toBeGreaterThan(selectStart);
    expect(snapshotBranch).toBeGreaterThan(sessionIsBusy);
    expect(block).toContain("session?.mode === 'codex'");
    expect(block).toContain('!sessionIsBusy');
    expect(block).toContain('!restoredSnapshot');
  });

  it('uses full terminal history when refreshing an active Codex session after dropped output', () => {
    const source = appSource();
    const refreshStart = source.indexOf('async _onSessionNeedsRefresh(');
    const fullFetch = source.indexOf('/terminal?full=1', refreshStart);
    const switchGuard = source.indexOf('if (this.activeSessionId !== sessionId) return;', refreshStart);
    const block = source.slice(refreshStart, switchGuard + 80);

    expect(refreshStart).toBeGreaterThan(-1);
    expect(fullFetch).toBeGreaterThan(refreshStart);
    // COD-189 wanted the FULL capture rather than the sparse byte tail for
    // codex/gemini/shell. Upstream generalized that: recovery always asks for
    // ?full=1, and only falls back to the tail when the replay would SHRINK the
    // buffer (a repaint-mode pane keeps ~one frame in tmux), which covers claude
    // too instead of special-casing it.
    expect(block).toContain('`/api/sessions/${sessionId}/terminal?full=1`');
    expect(block).toContain('this._replayWouldShrinkBuffer(data.terminalBuffer)');
    expect(block).toContain('`/api/sessions/${sessionId}/terminal?tail=${TERMINAL_TAIL_SIZE}`');
    // Two fetches wide, so a tab switch mid-fetch must not paint into the new tab.
    expect(switchGuard).toBeGreaterThan(fullFetch);
  });

  it('schedules a terminal buffer refresh after an unexpected active WebSocket close', () => {
    const source = appSource();
    const connectStart = source.indexOf('_connectWs(sessionId)');
    const closeStart = source.indexOf('ws.onclose = (event) => {', connectStart);
    const closeEnd = source.indexOf('ws.onerror = () => {', closeStart);
    const closeBlock = source.slice(closeStart, closeEnd);

    expect(closeStart).toBeGreaterThan(connectStart);
    expect(closeBlock).toContain('const stillActive = this.activeSessionId === sessionId');
    expect(closeBlock).toContain('this._scheduleWsCloseRefresh(sessionId)');
  });

  it('forces replay after clearing a busy tab even when the fetched frame matches cache', () => {
    const source = appSource();
    const cacheRestore = source.indexOf('Instant cache restore');
    const busyClear = source.indexOf('CACHE_SKIP_BUSY', cacheRestore);
    const needsRewrite = source.indexOf('const needsRewrite', busyClear);
    const replayBlock = source.slice(cacheRestore, needsRewrite + 160);

    expect(cacheRestore).toBeGreaterThan(-1);
    expect(busyClear).toBeGreaterThan(cacheRestore);
    expect(needsRewrite).toBeGreaterThan(busyClear);
    expect(replayBlock).toContain('clearedForBusy');
    expect(replayBlock).toContain('preserveSnapshotScrollback');
    // needsRewrite is unconditionally forced by clearedForBusy — mode-agnostic
    // since COD-92 removed the codex-only carve-out from this guard.
    expect(replayBlock).toContain('clearedForBusy || (!preserveSnapshotScrollback');

    // Behavioural: clearedForBusy alone must defeat preservation, even with
    // every other input set to favour preserving the snapshot (restored
    // snapshot, byte-identical canonical buffer, busy session) — and for
    // every mode, not just codex. Asserted on the predicate itself rather
    // than on a re-implementation of the call site, so the check actually
    // fails if clearedForBusy is dropped from the guard.
    const preserve = loadPreservePredicate();
    for (const mode of ['claude', 'codex', 'opencode', 'gemini', 'agy']) {
      expect(
        preserve({
          restoredSnapshot: true,
          clearedForBusy: true,
          requestFullHistory: false,
          canonicalUnchanged: true,
          sessionIsBusy: true,
          mode,
        }),
        mode
      ).toBe(false);
    }
  });

  it('loads the SerializeAddon and keeps a per-session snapshot map', () => {
    const terminalSource = readFileSync(resolve(import.meta.dirname, '../src/web/public/terminal-ui.js'), 'utf8');
    expect(terminalSource).toContain('this._xtermSnapshots = new Map()');
    expect(terminalSource).toContain('new SerializeAddon.SerializeAddon()');
    expect(terminalSource).toContain('this.terminal.loadAddon(this._serializeAddon)');
  });

  it('evicts the in-memory snapshot cache and persists with a bounded localStorage budget', () => {
    const source = appSource();
    // In-memory cache is LRU-bounded…
    expect(source).toContain('if (this._xtermSnapshots.size > 20)');
    // …per-snapshot localStorage writes are size-capped…
    expect(source).toContain('snapshot.length < 256 * 1024');
    // …and the persisted key set is pruned of dead sessions.
    expect(source).toContain("k.startsWith('codeman-xs-')");
  });
});
