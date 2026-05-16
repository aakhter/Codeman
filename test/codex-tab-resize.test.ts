import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

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
  });
});
