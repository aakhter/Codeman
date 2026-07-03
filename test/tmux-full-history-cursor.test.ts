import { describe, expect, it } from 'vitest';
import { formatFullHistoryCapture } from '../src/tmux-manager.js';

describe('formatFullHistoryCapture', () => {
  it('normalizes captured scrollback and restores the live pane cursor position', () => {
    const out = formatFullHistoryCapture('status row\nprompt row', {
      cols: 120,
      rows: 40,
      cursorX: 4,
      cursorY: 37,
    });

    expect(out).toBe('status row\r\nprompt row\x1b[38;5H');
  });

  it('falls back to CRLF-normalized scrollback when cursor geometry is unavailable', () => {
    expect(formatFullHistoryCapture('one\ntwo')).toBe('one\r\ntwo');
  });

  it('clamps cursor coordinates to the pane bounds', () => {
    const out = formatFullHistoryCapture('tail', {
      cols: 10,
      rows: 5,
      cursorX: 99,
      cursorY: -3,
    });

    expect(out).toBe('tail\x1b[1;10H');
  });
});
