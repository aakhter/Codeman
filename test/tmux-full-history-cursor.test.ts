import { describe, expect, it } from 'vitest';
import { formatFullHistoryCapture } from '../src/tmux-manager.js';
import { Terminal } from '@xterm/headless';

describe('formatFullHistoryCapture', () => {
  it.each([21, 40, 55])('keeps the cursor on the prompt when replayed into %i rows', async (rows) => {
    const lines = Array.from({ length: 40 }, (_, i) => `output ${i}`);
    lines[35] = '› type here';
    lines[36] = '';
    lines[37] = 'model · /workspace';
    lines[38] = '';
    lines[39] = '';
    const terminal = new Terminal({ cols: 120, rows, allowProposedApi: true });
    try {
      await new Promise<void>((resolve) =>
        terminal.write(
          formatFullHistoryCapture(lines.join('\n'), {
            cols: 120,
            rows: 40,
            cursorX: 2,
            cursorY: 35,
          }),
          resolve
        )
      );
      const buffer = terminal.buffer.active;
      expect(buffer.getLine(buffer.baseY + buffer.cursorY)?.translateToString(true)).toBe('› type here');
      expect(buffer.cursorX).toBe(2);
      await new Promise<void>((resolve) => terminal.write('X', resolve));
      expect(buffer.getLine(buffer.baseY + buffer.cursorY)?.translateToString(true)).toBe('› Xype here');
      expect(buffer.getLine(buffer.baseY + buffer.cursorY + 2)?.translateToString(true)).toBe('model · /workspace');
    } finally {
      terminal.dispose();
    }
  });
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
