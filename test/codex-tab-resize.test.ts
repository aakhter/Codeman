import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Codex tab resize behavior', () => {
  it('selectSession does not skip resize because another tab had the same dimensions', () => {
    const source = readFileSync(resolve(import.meta.dirname, '../src/web/public/app.js'), 'utf8');
    const start = source.indexOf('Also push the new dimensions to the PTY');
    const resizeCall = source.indexOf('this.sendResize(sessionId, { forceHttp: true })', start);
    const snapshotRestore = source.indexOf('xterm snapshot restore', start);

    expect(start).toBeGreaterThan(-1);
    expect(resizeCall).toBeGreaterThan(start);
    expect(resizeCall).toBeLessThan(snapshotRestore);
    expect(source.slice(start, resizeCall)).not.toContain('_lastResizeDims');
  });

  it('selectSession can restore terminal content before any resize settle delay', () => {
    const source = readFileSync(resolve(import.meta.dirname, '../src/web/public/app.js'), 'utf8');
    const start = source.indexOf('Load terminal buffer for this session');
    const snapshotRestore = source.indexOf('xterm snapshot restore', start);
    const cacheRestore = source.indexOf('Instant cache restore', start);
    const settleDelay = source.indexOf('setTimeout(resolve, 400)', start);

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
    expect(fetchBlock).toContain("session?.mode === 'shell'");
    expect(fetchBlock).toContain('`/api/sessions/${sessionId}/terminal`');
    expect(fetchBlock).toContain('`/api/sessions/${sessionId}/terminal?tail=${TERMINAL_TAIL_SIZE}`');
  });

  it('rejects blank xterm snapshots before saving or restoring them', () => {
    const source = readFileSync(resolve(import.meta.dirname, '../src/web/public/app.js'), 'utf8');
    const helper = source.indexOf('_isUsableXtermSnapshot(snapshot)');
    const save = source.indexOf('this._xtermSnapshots.set(this.activeSessionId, snapshot)');
    const restore = source.indexOf('SNAPSHOT_RESTORE:', save);
    const restoreBlock = source.slice(save, restore);

    expect(helper).toBeGreaterThan(-1);
    expect(source.slice(save - 250, save)).toContain('this._isUsableXtermSnapshot(snapshot)');
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
    const postSnapshotRestore = source.slice(snapshotRestore, needsRewrite + 120);

    expect(snapshotRestore).toBeGreaterThan(-1);
    expect(cacheRestore).toBeGreaterThan(snapshotRestore);
    expect(fetchStart).toBeGreaterThan(cacheRestore);
    expect(needsRewrite).toBeGreaterThan(fetchStart);
    expect(snapshotBlock).not.toContain('this._finishBufferLoad();');
    expect(snapshotBlock).not.toContain("Don't fall through to buffer-fetch");
    expect(postSnapshotRestore).toContain('restoredSnapshot');
    expect(postSnapshotRestore).toContain('restoredSnapshot || clearedForBusy || data.terminalBuffer !== cachedBuffer');
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
    expect(replayBlock).toContain('clearedForBusy');
    expect(replayBlock).toContain('restoredSnapshot || clearedForBusy || data.terminalBuffer !== cachedBuffer');
  });

  it('nudges xterm to repaint after session restore and browser refocus', () => {
    const appSource = readFileSync(resolve(import.meta.dirname, '../src/web/public/app.js'), 'utf8');
    const terminalSource = readFileSync(resolve(import.meta.dirname, '../src/web/public/terminal-ui.js'), 'utf8');
    const focus = appSource.indexOf("_crashDiag.log('FOCUS')");
    const selectDone = appSource.indexOf('SELECT_DONE', focus);
    const visibilityListener = appSource.indexOf("document.addEventListener('visibilitychange'");
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
    const selectDone = source.indexOf('SELECT_DONE', loadStart);
    const selectBlock = source.slice(loadStart, selectDone);
    const catchBlock = source.slice(
      source.indexOf('} catch (err) {', selectDone),
      source.indexOf("console.error('Failed to load session terminal:'", selectDone)
    );

    expect(staleHelper).toContain('this._finishBufferLoad(selectGen)');
    expect(loadStart).toBeGreaterThan(-1);
    expect(selectBlock).toContain('this.chunkedTerminalWrite(cachedBuffer, TERMINAL_CHUNK_SIZE, bufferLoadOwner)');
    expect(selectBlock).toContain(
      'this.chunkedTerminalWrite(data.terminalBuffer, TERMINAL_CHUNK_SIZE, bufferLoadOwner)'
    );
    expect(selectBlock).toContain('this._finishBufferLoad(bufferLoadOwner)');
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
