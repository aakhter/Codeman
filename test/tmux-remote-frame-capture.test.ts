/**
 * @fileoverview COD-187 (live mirror) — remote visible-frame capture helpers.
 *
 * `buildRemoteFrameCommand` must fetch the VISIBLE frame (no `-S -`) plus the
 * pane geometry in ONE combined command; `parseRemoteFrameCapture` repaints
 * the frame at absolute positions (formatPaneSnapshot parity with the local
 * visible path) and degrades gracefully on delimiter/geometry failure.
 *
 * Pure helpers — no ssh, no tmux. Port: N/A.
 */
import { describe, it, expect } from 'vitest';
import { buildRemoteFrameCommand, parseRemoteFrameCapture, formatPaneSnapshot } from '../src/tmux-manager.js';

const DELIM = '__CODEMAN_GEOM__';

describe('COD-187 buildRemoteFrameCommand', () => {
  it('fetches the visible frame (no -S -) and geometry in one command', () => {
    const cmd = buildRemoteFrameCommand('codeman-abcd1234');
    expect(cmd).toContain("capture-pane -p -e -t 'codeman-abcd1234'");
    expect(cmd).not.toContain('-S -');
    expect(cmd).toContain(DELIM);
    expect(cmd).toContain(
      "display-message -p -t 'codeman-abcd1234' '#{cursor_x} #{cursor_y} #{pane_width} #{pane_height}'"
    );
    // capture must come BEFORE geometry so parse order matches
    expect(cmd.indexOf('capture-pane')).toBeLessThan(cmd.indexOf('display-message'));
  });
});

describe('COD-187 parseRemoteFrameCapture', () => {
  it('repaints at absolute positions with cursor restore when geometry parses', () => {
    const stdout = `line one\nline two\n${DELIM}\n5 1 80 24\n`;
    const parsed = parseRemoteFrameCapture(stdout);
    expect(parsed).toBe(formatPaneSnapshot(['line one', 'line two'], { cols: 80, rows: 24, cursorX: 5, cursorY: 1 }));
    expect(parsed).toContain('\x1b[1;1Hline one');
    expect(parsed).toContain('\x1b[2;1Hline two');
    expect(parsed?.endsWith('\x1b[2;6H')).toBe(true); // cursor at row 2, col 6 (1-based)
  });

  it('degrades to normalized linear text when geometry is malformed', () => {
    const stdout = `line one\nline two\n${DELIM}\nnot geometry\n`;
    const parsed = parseRemoteFrameCapture(stdout);
    expect(parsed).toBe('line one\r\nline two');
  });

  it('degrades to normalized linear text when the delimiter is missing', () => {
    const parsed = parseRemoteFrameCapture('only capture output\n\n');
    expect(parsed).toBe('only capture output');
  });

  it('returns null for an empty capture so callers fall back to the local wrapper', () => {
    expect(parseRemoteFrameCapture(`\n${DELIM}\n80 24 0 0\n`)).toBeNull();
    expect(parseRemoteFrameCapture('')).toBeNull();
  });
});
