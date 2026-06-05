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

  it('does not let xterm snapshots skip the fresh terminal buffer fetch', () => {
    const source = readFileSync(resolve(import.meta.dirname, '../src/web/public/app.js'), 'utf8');
    const start = source.indexOf('xterm snapshot restore');
    const snapshotCondition = source.match(/if \(snapshot && [^)]+\)/)?.[0] || '';
    const snapshotDone = source.indexOf('SNAPSHOT_RESTORE_DONE', start);
    const fetchStart = source.indexOf("_crashDiag.log('FETCH_START')", start);
    const snapshotBlockEnd = source.indexOf('const cachedBuffer = this.terminalBufferCache.get(sessionId);', start);

    expect(start).toBeGreaterThan(-1);
    expect(snapshotCondition).toContain("session?.mode === 'codex'");
    expect(fetchStart).toBeGreaterThan(start);
    expect(snapshotBlockEnd).toBeGreaterThan(snapshotDone);
    expect(source.slice(snapshotDone, snapshotBlockEnd)).not.toContain('return;');
  });

  it('waits for xterm to parse small buffer writes before resolving tab switch restore', () => {
    const source = readFileSync(resolve(import.meta.dirname, '../src/web/public/terminal-ui.js'), 'utf8');
    const start = source.indexOf('For small buffers, write directly');
    const smallWriteBlock = source.slice(start, source.indexOf('// Large buffers', start));

    expect(start).toBeGreaterThan(-1);
    expect(smallWriteBlock).toContain('this.terminal.write(cleanBuffer, finish)');
    expect(smallWriteBlock).not.toContain('this.terminal.write(cleanBuffer);\n        finish();');
  });

  it('lets clicking the active tab force a fresh terminal reload', () => {
    const source = readFileSync(resolve(import.meta.dirname, '../src/web/public/app.js'), 'utf8');
    const selectStart = source.indexOf('async selectSession(sessionId, options = {})');
    const selectSetup = source.slice(selectStart, source.indexOf('// Focus terminal SYNCHRONOUSLY', selectStart));

    expect(selectStart).toBeGreaterThan(-1);
    expect(source).toContain('onclick="app.selectSession(\'${escapeHtml(id)}\', { forceReload: true })"');
    expect(source).toContain('this.selectSession(sessionId, { forceReload: true });');
    expect(selectSetup).toContain('this.activeSessionId === sessionId && forceReload');
    expect(selectSetup).toContain('this.terminalBufferCache?.delete(sessionId)');
    expect(selectSetup).toContain('this._xtermSnapshots?.delete(sessionId)');
    expect(selectSetup).toContain('this.activeSessionId = null');
  });

  it('scrolls replayed buffers to the last non-empty terminal line', () => {
    const appSource = readFileSync(resolve(import.meta.dirname, '../src/web/public/app.js'), 'utf8');
    const terminalSource = readFileSync(resolve(import.meta.dirname, '../src/web/public/terminal-ui.js'), 'utf8');

    expect(terminalSource).toContain('scrollToLastNonEmptyLine()');
    expect(terminalSource).toContain('this.terminal.scrollToLine');

    const rewriteStart = appSource.indexOf('REWRITE: ${');
    const rewriteBlock = appSource.slice(rewriteStart, appSource.indexOf('// Update cache', rewriteStart));
    expect(rewriteBlock).toContain('this.scrollToLastNonEmptyLine();');
    expect(rewriteBlock).not.toContain('this.terminal.scrollToBottom();');
  });
});
