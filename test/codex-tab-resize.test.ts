import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

// COD-92 extracted the preserve-or-rewrite decision into a pure, mode-agnostic
// predicate (`_shouldPreserveSnapshotScrollback`, terminal-ui.js). Load it
// through the same vm harness as test/snapshot-preserve-predicate.test.ts so
// tests here can assert behaviour directly instead of pinning source
// substrings specific to one CLI mode.
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

describe('Codex tab resize behavior', () => {
  it('selectSession does not skip resize because another tab had the same dimensions', () => {
    const source = readFileSync(resolve(import.meta.dirname, '../src/web/public/app.js'), 'utf8');
    const start = source.indexOf('Also push the new dimensions to the PTY');
    const resizeCall = source.indexOf('this.sendResize(sessionId)', start);
    const snapshotRestore = source.indexOf('xterm snapshot restore', start);

    expect(start).toBeGreaterThan(-1);
    expect(resizeCall).toBeGreaterThan(start);
    expect(resizeCall).toBeLessThan(snapshotRestore);
    expect(source.slice(start, resizeCall)).not.toContain('_lastResizeDims');
    expect(source.slice(start, snapshotRestore)).not.toContain('forceHttp');
  });

  it('selectSession can restore terminal content before any resize settle delay', () => {
    const source = readFileSync(resolve(import.meta.dirname, '../src/web/public/app.js'), 'utf8');
    const start = source.indexOf('Load terminal buffer for this session');
    const snapshotRestore = source.indexOf('xterm snapshot restore', start);
    const cacheRestore = source.indexOf('Instant cache restore', start);
    const settleDelay = source.indexOf('setTimeout(resolve, TUI_REDRAW_SETTLE_MS)', start);

    expect(start).toBeGreaterThan(-1);
    expect(snapshotRestore).toBeGreaterThan(start);
    expect(cacheRestore).toBeGreaterThan(snapshotRestore);
    expect(settleDelay).toBeGreaterThan(-1);
    expect(settleDelay).toBeGreaterThan(cacheRestore);
    expect(source.slice(cacheRestore, settleDelay)).toContain("session?.mode !== 'shell'");
  });

  it('fetches full terminal history for shell session reloads', () => {
    const source = readFileSync(resolve(import.meta.dirname, '../src/web/public/app.js'), 'utf8');
    const selectStart = source.indexOf('async selectSession(sessionId, options = {})');
    const fetchStart = source.indexOf("_crashDiag.log('FETCH_START')", selectStart);
    const fetchBlock = source.slice(fetchStart, source.indexOf('const res = await fetch(terminalUrl);', fetchStart));

    expect(selectStart).toBeGreaterThan(-1);
    expect(fetchStart).toBeGreaterThan(selectStart);
    // #205 made shell take the SAME full-history path as every other mode
    // (that fix is what restored shell scrollback), so shell must no longer be
    // special-cased out of it.
    expect(fetchBlock).not.toContain("session?.mode === 'shell'");
    expect(fetchBlock).toContain('`/api/sessions/${sessionId}/terminal?full=1`');
    expect(fetchBlock).toContain('`/api/sessions/${sessionId}/terminal?tail=${TERMINAL_TAIL_SIZE}`');
  });

  it('rejects blank xterm snapshots before saving or restoring them', () => {
    const source = readFileSync(resolve(import.meta.dirname, '../src/web/public/app.js'), 'utf8');
    const helper = source.indexOf('_isUsableXtermSnapshot(snapshot)');
    const save = source.indexOf('this._xtermSnapshots.set(this.activeSessionId, snapshot)');
    const restore = source.indexOf('SNAPSHOT_RESTORE:', save);
    const restoreBlock = source.slice(save, restore);

    expect(helper).toBeGreaterThan(-1);
    // Window widened from 250: the upstream delete-before-set LRU hardening
    // (9893a7f) added a 3-line comment + delete() call between the guard and the
    // set, so the guard now sits ~338 chars back. The invariant (save is gated on
    // _isUsableXtermSnapshot) is unchanged.
    expect(source.slice(save - 450, save)).toContain('this._isUsableXtermSnapshot(snapshot)');
    expect(restoreBlock).toContain('if (snapshot && !this._isUsableXtermSnapshot(snapshot))');
    expect(restoreBlock).toContain('persisted && this._isUsableXtermSnapshot(persisted)');
  });

  it('uses xterm snapshots as first paint but still fetches the canonical terminal frame', () => {
    const source = readFileSync(resolve(import.meta.dirname, '../src/web/public/app.js'), 'utf8');
    const snapshotRestore = source.indexOf('SNAPSHOT_RESTORE:');
    const cacheRestore = source.indexOf('Instant cache restore', snapshotRestore);
    const fetchStart = source.indexOf("FETCH_START'", snapshotRestore);
    const needsRewrite = source.indexOf('const needsRewrite', fetchStart);
    const snapshotBlock = source.slice(snapshotRestore, cacheRestore);
    const postSnapshotRestore = source.slice(snapshotRestore, needsRewrite + 220);

    expect(snapshotRestore).toBeGreaterThan(-1);
    expect(cacheRestore).toBeGreaterThan(snapshotRestore);
    expect(fetchStart).toBeGreaterThan(cacheRestore);
    expect(needsRewrite).toBeGreaterThan(fetchStart);
    expect(snapshotBlock).not.toContain('this._finishBufferLoad();');
    expect(snapshotBlock).not.toContain("Don't fall through to buffer-fetch");
    expect(postSnapshotRestore).toContain('restoredSnapshot');
    expect(postSnapshotRestore).toContain('preserveSnapshotScrollback');
  });

  it('does not hard-reload or delete snapshots for ordinary tab clicks', () => {
    const source = readFileSync(resolve(import.meta.dirname, '../src/web/public/app.js'), 'utf8');
    const clickStart = source.indexOf('handleSessionTabClick(event, sessionId)');
    const clickEnd = source.indexOf('// ═══════════════════════════════════════════════════════════════', clickStart);
    const clickBlock = source.slice(clickStart, clickEnd);
    const forceReloadBranch = source.slice(
      source.indexOf('if (this.activeSessionId === sessionId && forceReload)'),
      source.indexOf(
        '// Focus terminal SYNCHRONOUSLY',
        source.indexOf('if (this.activeSessionId === sessionId && forceReload)')
      )
    );

    expect(clickStart).toBeGreaterThan(-1);
    expect(clickBlock).toContain('this.selectSession(sessionId)');
    expect(clickBlock).not.toContain('forceReload: true');
    expect(forceReloadBranch).toContain('this.terminalBufferCache?.delete(sessionId)');
    expect(forceReloadBranch).not.toContain('this._xtermSnapshots?.delete(sessionId)');
    expect(forceReloadBranch).not.toContain('localStorage.removeItem(`codeman-xs-${sessionId}`)');
  });

  it('keeps restored Codex snapshots from being overwritten by the fetched TUI frame', () => {
    const source = readFileSync(resolve(import.meta.dirname, '../src/web/public/app.js'), 'utf8');
    const selectStart = source.indexOf('async selectSession(sessionId, options = {})');
    const sessionIsBusy = source.indexOf('const sessionIsBusy', selectStart);
    const needsRewrite = source.indexOf('const needsRewrite', sessionIsBusy);
    const rewriteBlock = source.slice(sessionIsBusy, source.indexOf('if (needsRewrite)', needsRewrite));

    expect(selectStart).toBeGreaterThan(-1);
    expect(sessionIsBusy).toBeGreaterThan(selectStart);
    expect(rewriteBlock).toContain('const preserveSnapshotScrollback');
    expect(rewriteBlock).toContain("session?.mode === 'codex'");
    expect(rewriteBlock).toContain('!preserveSnapshotScrollback');
    expect(rewriteBlock).not.toContain('restoredSnapshot || clearedForBusy || data.terminalBuffer !== cachedBuffer');
  });

  it('declares the snapshot-restore flag before selectSession uses it', () => {
    const source = readFileSync(resolve(import.meta.dirname, '../src/web/public/app.js'), 'utf8');
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

  it('forces replay after clearing a busy tab even when the fetched frame matches cache', () => {
    const source = readFileSync(resolve(import.meta.dirname, '../src/web/public/app.js'), 'utf8');
    const cacheRestore = source.indexOf('Instant cache restore');
    const busyClear = source.indexOf('CACHE_SKIP_BUSY', cacheRestore);
    const needsRewrite = source.indexOf('const needsRewrite', busyClear);
    const replayBlock = source.slice(cacheRestore, needsRewrite + 160);

    expect(cacheRestore).toBeGreaterThan(-1);
    expect(busyClear).toBeGreaterThan(cacheRestore);
    expect(needsRewrite).toBeGreaterThan(busyClear);
    // The local was renamed clearedForBusy -> clearedBeforeFresh and the expression
    // wrapped across lines; it is still passed as the `clearedForBusy` input to the
    // preserve predicate, and the guard shape is unchanged. Matched on collapsed
    // whitespace so a rename of the LOCAL cannot masquerade as a logic change (COD-385).
    const replayFlat = replayBlock.replace(/\s+/g, ' ');
    expect(replayFlat).toContain('clearedForBusy: clearedBeforeFresh');
    expect(replayFlat).toContain('preserveSnapshotScrollback');
    // needsRewrite is unconditionally forced by the cleared-for-busy flag —
    // mode-agnostic since COD-92 removed the codex-only carve-out from this guard.
    expect(replayFlat).toContain('clearedBeforeFresh || (!preserveSnapshotScrollback');

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

  it('nudges xterm to repaint after session restore and browser refocus', () => {
    const appSource = readFileSync(resolve(import.meta.dirname, '../src/web/public/app.js'), 'utf8');
    const terminalSource = readFileSync(resolve(import.meta.dirname, '../src/web/public/terminal-ui.js'), 'utf8');
    const focus = appSource.indexOf("_crashDiag.log('FOCUS')");
    const selectDone = appSource.indexOf('SELECT_DONE', focus);
    const setupEvents = appSource.indexOf('setupEventListeners()');
    const visibilityListener = appSource.indexOf("document.addEventListener('visibilitychange'", setupEvents);
    const windowFocusListener = appSource.indexOf("window.addEventListener('focus'");

    expect(focus).toBeGreaterThan(-1);
    expect(selectDone).toBeGreaterThan(focus);
    expect(appSource.slice(focus, selectDone)).toContain('this._scheduleTerminalRepaint()');
    expect(visibilityListener).toBeGreaterThan(-1);
    expect(appSource.slice(visibilityListener, visibilityListener + 400)).toContain('this._scheduleTerminalRepaint()');
    expect(windowFocusListener).toBeGreaterThan(-1);
    expect(appSource.slice(windowFocusListener, windowFocusListener + 300)).toContain(
      'this._scheduleTerminalRepaint()'
    );
    expect(terminalSource).toContain('_scheduleTerminalRepaint()');
    expect(terminalSource).toContain('this.terminal.refresh(0, this.terminal.rows - 1)');
  });

  it('keeps selectSession buffer-load cleanup scoped to the active generation', () => {
    const source = readFileSync(resolve(import.meta.dirname, '../src/web/public/app.js'), 'utf8');
    const staleHelper = source.slice(
      source.indexOf('_isStaleSelect(selectGen)'),
      source.indexOf('return false;', source.indexOf('_isStaleSelect(selectGen)'))
    );
    const loadStart = source.indexOf('const bufferLoadOwner = this._beginBufferLoad(selectGen);');
    const selectDone = source.indexOf('_crashDiag.log(`SELECT_DONE:', loadStart);
    const selectBlock = source.slice(loadStart, selectDone);
    // Prettier wrapped these calls across lines, which broke single-line greps while
    // the argument lists were unchanged. Match on whitespace-collapsed source so a
    // reformat cannot fail the gate (COD-385).
    const flat = (text) => text.replace(/\s+/g, ' ');
    const selectBlockFlat = flat(selectBlock);
    const catchBlock = source.slice(
      source.indexOf('} catch (err) {', selectDone),
      source.indexOf("console.error('Failed to load session terminal:'", selectDone)
    );

    expect(staleHelper).toContain('this._finishBufferLoad(selectGen)');
    expect(loadStart).toBeGreaterThan(-1);
    expect(selectBlockFlat).toContain(
      'this.chunkedTerminalWrite( cachedBuffer, TERMINAL_CHUNK_SIZE, bufferLoadOwner )'
    );
    expect(selectBlockFlat).toContain(
      'this.chunkedTerminalWrite( data.terminalBuffer, TERMINAL_CHUNK_SIZE, bufferLoadOwner )'
    );
    expect(selectBlockFlat).toContain('this._finishBufferLoad(bufferLoadOwner, { flushQueued: bufferWasEmpty })');
    expect(catchBlock).toContain('this._finishBufferLoad(bufferLoadOwner)');
    expect(selectBlock).not.toContain('this._finishBufferLoad()');
    expect(catchBlock).not.toContain('this._finishBufferLoad()');
  });

  it('repaints the terminal after WebGL renderer fallback paths', () => {
    const source = readFileSync(resolve(import.meta.dirname, '../src/web/public/app.js'), 'utf8');
    const contextLoss = source.slice(
      source.indexOf('this._webglAddon.onContextLoss(() => {'),
      source.indexOf('this.terminal.loadAddon(this._webglAddon);')
    );
    const longTaskFallback = source.slice(
      source.indexOf("this._disableWebGLSticky('long-tasks');"),
      source.indexOf('});', source.indexOf("this._disableWebGLSticky('long-tasks');"))
    );

    expect(contextLoss).toContain("this._disableWebGLSticky('context-lost')");
    expect(contextLoss).toContain('this._disposeWebGLObserver()');
    expect(contextLoss).toContain('this._webglAddon?.dispose()');
    expect(contextLoss).toContain('this._scheduleTerminalRepaint()');

    expect(longTaskFallback).toContain('this._webglAddon?.dispose()');
    expect(longTaskFallback).toContain('this._scheduleTerminalRepaint()');
  });
});
