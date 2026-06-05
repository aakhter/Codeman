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

  it('only lets codex sessions skip the fresh terminal buffer fetch via xterm snapshots', () => {
    const source = readFileSync(resolve(import.meta.dirname, '../src/web/public/app.js'), 'utf8');
    const start = source.indexOf('xterm snapshot restore');
    const snapshotCondition = source.match(/if \(snapshot && [^)]+\)/)?.[0] || '';
    const fetchStart = source.indexOf("_crashDiag.log('FETCH_START')", start);

    expect(start).toBeGreaterThan(-1);
    expect(snapshotCondition).toContain("session?.mode === 'codex'");
    expect(fetchStart).toBeGreaterThan(start);
  });
});
