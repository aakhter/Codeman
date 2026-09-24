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
import { formatCursorRestore, formatPaneSnapshot, hasVisibleContent } from '../src/tmux-manager.js';

describe('tmux full-history pane capture (COD-47)', () => {
  const source = readFileSync(resolve(import.meta.dirname, '../src/tmux-manager.ts'), 'utf8');
  const methodStart = source.indexOf('capturePaneBuffer(muxName: string');
  // Bounded at the next method so `methodBody` really is one method: the
  // ordering assertions below would otherwise be satisfiable by a neighbour.
  const methodEnd = source.indexOf('captureActivePaneBuffer(muxName: string', methodStart);
  const methodBody = source.slice(methodStart, methodEnd);

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
    // The fullHistory branch returns before the formatPaneSnapshot repaint,
    // which is single-screen and would clip a multi-screen history.
    const branch = methodBody.indexOf('if (fullHistory) {\n        // COD-190');
    const snapshot = methodBody.indexOf('formatPaneSnapshot(');
    expect(branch).toBeGreaterThan(-1);
    expect(snapshot).toBeGreaterThan(-1);
    expect(branch).toBeLessThan(snapshot);
    // …and what it returns is linear scrollback (CRLF-normalized inside
    // formatFullHistoryCapture), not a repaint.
    expect(methodBody.slice(branch, snapshot)).toContain('formatFullHistoryCapture(');
  });

  it('appends the pane cursor to the full-history capture', () => {
    // A linear replay leaves the caret wherever the last character landed — the
    // status line, for an agent CLI — and every cursor-relative update the CLI
    // sends afterwards is then measured from the wrong row. COD-433 anchors that
    // move to the captured tail, which is what formatFullHistoryCapture does.
    const restore = methodBody.indexOf('formatFullHistoryCapture(trimmed, geometry)');
    const snapshot = methodBody.indexOf('formatPaneSnapshot(');
    expect(restore).toBeGreaterThan(-1);
    expect(restore).toBeLessThan(snapshot);
  });

  it('keeps the trailing rows, and queries the cursor before deciding anything', () => {
    // COD-190: trailing blank rows are the bottom of the screen and the cursor
    // move counts up from them, so only the line terminator comes off. The
    // geometry has to be in hand before that branch runs, since it is what the
    // move is computed from.
    expect(methodBody).toContain("rawCapture.replace(/\\n$/, '')");
    const cursorQuery = methodBody.indexOf('queryPaneCursor(');
    expect(cursorQuery).toBeGreaterThan(-1);
    expect(cursorQuery).toBeLessThan(methodBody.indexOf('if (fullHistory) {\n        // COD-190'));
  });

  it('defers to the byte history when the pane holds nothing visible', () => {
    expect(methodBody).toContain("if (!hasVisibleContent(trimmed)) return ''");
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
    // Asserted as an ORDERING rather than one literal command string: the expression
    // was refactored (`Math.floor(historyLimit)` -> `safeHistoryLimit`) and a tmux-3.7
    // live-resize branch was added alongside it, which silently broke the old grep
    // while the invariant itself still held (COD-385).
    const assignment = source.slice(
      source.indexOf('const createSessionCommand ='),
      source.indexOf('execSync(createSessionCommand')
    );
    expect(assignment).not.toBe('');

    // The legacy branch (tmux < 3.7, no live pane resize) is the one that must set the
    // GLOBAL option first, because the pane inherits it only at creation time.
    const legacyBranch = assignment.slice(assignment.indexOf(': `'));
    const globalSet = legacyBranch.indexOf('set-option -g history-limit');
    const newSession = legacyBranch.indexOf('new-session -ds');
    expect(globalSet).toBeGreaterThan(-1);
    expect(newSession).toBeGreaterThan(-1);
    expect(globalSet).toBeLessThan(newSession);
    // Same shell invocation (tmux command separator), not a follow-up call.
    expect(legacyBranch.slice(globalSet, newSession)).toContain(';');
  });
});

describe('full-history cursor restore', () => {
  it('counts up from the last replayed row rather than down from the top', () => {
    // Relative, not `CUP`: absolute row addressing is only correct while the
    // browser's row count equals the pane's, and resizeWindow does not wait for
    // tmux, so a capture can be taken before a requested resize has applied.
    expect(formatCursorRestore({ cols: 80, rows: 24, cursorX: 2, cursorY: 20 })).toBe('\x1b[3A\r\x1b[2C');
  });

  it('emits no row move when the caret is already on the last row', () => {
    expect(formatCursorRestore({ cols: 80, rows: 24, cursorX: 5, cursorY: 23 })).toBe('\r\x1b[5C');
  });

  it('emits no column move for column zero', () => {
    expect(formatCursorRestore({ cols: 80, rows: 10, cursorX: 0, cursorY: 0 })).toBe('\x1b[9A\r');
  });
});

describe('hasVisibleContent', () => {
  it('is false for a pane of blank rows', () => {
    expect(hasVisibleContent('\n'.repeat(23))).toBe(false);
  });

  it('is false for blank rows carrying only SGR attributes', () => {
    // `capture-pane -e` styles every row, so an all-blank pane is not an empty
    // string. Treating it as content would replace the byte history with a
    // blank screen.
    expect(hasVisibleContent('\x1b[m   \x1b[0m\n\x1b[m   \x1b[0m')).toBe(false);
  });

  it('is true as soon as one row carries a character', () => {
    expect(hasVisibleContent('\x1b[m   \x1b[0m\n\x1b[m x \x1b[0m')).toBe(true);
  });
});

describe('the geometry a capture reports back', () => {
  const source = readFileSync(resolve(import.meta.dirname, '../src/tmux-manager.ts'), 'utf8');
  const methodStart = source.indexOf('capturePaneBuffer(muxName: string');
  const methodEnd = source.indexOf('captureActivePaneBuffer(muxName: string', methodStart);
  const methodBody = source.slice(methodStart, methodEnd);

  it('writes the pane size onto the caller options before either replay path returns', () => {
    // IS_TEST_MODE no-ops execSync, so assert from source (same approach as the
    // capture-flag tests above). The write must precede the fullHistory branch:
    // both paths return from inside it, and a caller that got no geometry
    // cannot tell a mismatched frame from a matching one.
    const write = methodBody.indexOf('opts.capturedGeometry = { cols: geometry.cols, rows: geometry.rows }');
    // Anchor on the REPLAY branch, not the earlier `if (fullHistory)` that only
    // sizes the exec buffer.
    const replayBranch = methodBody.indexOf('if (!geometry) return normalizeScrollbackEol(');
    const visibleReturn = methodBody.indexOf('if (geometry) return formatPaneSnapshot(');
    expect(write).toBeGreaterThan(-1);
    expect(replayBranch).toBeGreaterThan(-1);
    expect(visibleReturn).toBeGreaterThan(-1);
    expect(write).toBeLessThan(replayBranch);
    expect(write).toBeLessThan(visibleReturn);
  });

  it('reports nothing when the cursor query gave no geometry', () => {
    // `queryPaneCursor` returns null on a failed or nonsensical query, and the
    // snapshot repaint is skipped in that case. Reporting a size anyway would
    // describe a frame that was never positioned.
    expect(methodBody).toContain('if (opts && geometry)');
  });
});

describe('why a capture has to report its height', () => {
  it('a snapshot addresses rows the receiving terminal may not have', () => {
    // formatPaneSnapshot positions every row absolutely. A terminal shorter
    // than the pane clamps each address past its own height onto its last
    // line, so the overflow rows overwrite one another and the rows underneath
    // are lost. Nothing in the escape sequence tells the client this happened —
    // hence captureRows on the response.
    const lines = Array.from({ length: 50 }, (_, i) => `row-${i + 1}`);
    // cursorX 5 keeps the trailing cursor-restore move (`\x1b[50;6H`) out of the
    // `;1H` row-paint match below, so the count is row paints alone.
    const snapshot = formatPaneSnapshot(lines, { cols: 100, rows: 50, cursorX: 5, cursorY: 49 });
    const addressed = [...snapshot.matchAll(/\x1b\[(\d+);1H/g)].map((m) => Number(m[1]));

    expect(Math.max(...addressed)).toBe(50);
    // A 30-row terminal cannot honour 20 of those addresses.
    expect(addressed.filter((row) => row > 30)).toHaveLength(20);
  });
});
