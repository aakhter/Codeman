/**
 * COD-47: full tmux scrollback replay on reload.
 *
 * Under VITEST, TmuxManager no-ops execSync (IS_TEST_MODE), so we can't drive
 * real tmux. Instead we assert the capture-arg construction directly from
 * source (same approach as tmux-capture-color.test.ts): a full-history capture
 * must use `capture-pane -p -e -S -` and skip the single-screen snapshot
 * repaint, while the visible capture keeps `capture-pane -p -e`.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('tmux full-history pane capture (COD-47)', () => {
  const source = readFileSync(resolve(import.meta.dirname, '../src/tmux-manager.ts'), 'utf8');

  it('capturePaneBuffer accepts a fullHistory option', () => {
    const sig = source.indexOf('capturePaneBuffer(');
    expect(sig).toBeGreaterThan(-1);
    // The method signature must carry the opts.fullHistory channel (COD-187
    // reformatted it multi-line and added lastLines for the lazy history page).
    // The v1.16 upstream merge moved those fields out of an inline object type
    // and into the shared PaneCaptureOptions, so follow the type rather than
    // scraping for the field name next to the signature.
    expect(source.slice(sig, sig + 240)).toContain('PaneCaptureOptions');
    const muxInterface = readFileSync(resolve(import.meta.dirname, '../src/mux-interface.ts'), 'utf8');
    const opts = muxInterface.slice(muxInterface.indexOf('export interface PaneCaptureOptions'));
    expect(opts.slice(0, opts.indexOf('}'))).toContain('fullHistory');
    expect(opts.slice(0, opts.indexOf('}'))).toContain('lastLines');
  });

  it('full-history mode requests the entire scrollback with -S - (via captureStartFlag)', () => {
    // COD-187: the start flag is templated so the lazy history page can bound
    // the capture (`-S -N`); unbounded remains the default.
    expect(source).toContain('capture-pane -p -e ${captureStartFlag(opts?.lastLines)}');
    expect(source).toContain("return '-S -';");
  });

  it('still offers the visible single-screen capture for fast tab switches', () => {
    expect(source).toContain("'capture-pane -p -e'");
  });

  it('returns full-history capture as raw scrollback (skips the single-screen repaint)', () => {
    const sig = source.indexOf('capturePaneBuffer(');
    const body = source.slice(sig, sig + 3400);
    // When fullHistory, return the raw buffer BEFORE the formatPaneSnapshot
    // repaint (which is single-screen and would clip a multi-screen history).
    const earlyReturn = body.indexOf('if (fullHistory)');
    const snapshot = body.indexOf('formatPaneSnapshot(');
    expect(earlyReturn).toBeGreaterThan(-1);
    expect(snapshot).toBeGreaterThan(-1);
    expect(earlyReturn).toBeLessThan(snapshot);
  });

  it('captureActivePaneBuffer forwards the fullHistory option', () => {
    const sig = source.indexOf('captureActivePaneBuffer(muxName: string');
    expect(sig).toBeGreaterThan(-1);
    const body = source.slice(sig, sig + 800);
    expect(body).toContain('opts');
    expect(body).toContain('this.capturePaneBuffer(muxName, target, opts)');
  });

  it('COD-279: remote history capture targets the dedicated codeman-remote socket and codeman-ssh name', () => {
    // Regression: owned remote sessions live on `-L codeman-remote` under a
    // `codeman-ssh-<id8>` name. The history (full-history) capture must use the
    // same socket the launcher created, or it resolves the wrong (nonexistent)
    // tmux socket and degrades to the local wrapper -> "history unavailable".
    const sig = source.indexOf('captureRemotePaneBuffer(');
    expect(sig).toBeGreaterThan(-1);
    const body = source.slice(sig, sig + 4000);
    expect(body).toContain('REMOTE_TMUX_SOCKET');
    expect(body).toContain('remoteTmuxSessionName(sessionId)');
    expect(body).toContain('`tmux -L ${socket} capture-pane');
    expect(body).toContain('`tmux -L ${socket} display-message');
  });
});

describe('COD-189 local history-limit ordering', () => {
  const source = readFileSync(resolve(import.meta.dirname, '../src/tmux-manager.ts'), 'utf8');

  it('sets -g history-limit in the SAME invocation, BEFORE new-session (pane inherits it)', () => {
    // history-limit only applies to panes created after it is set, and
    // respawn-pane reuses the initial pane — an after-the-fact set never lands.
    const combined = source.indexOf('set-option -g history-limit ${Math.floor(historyLimit)} \\\\; new-session -ds');
    expect(combined).toBeGreaterThan(-1);
  });
});
