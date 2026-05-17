import { describe, expect, it } from 'vitest';
import { Session } from '../src/session.js';

type SessionInternals = {
  _handleTerminalOutput(data: string): void;
  _ptyRows: number;
};

function handleOutput(session: Session, data: string): void {
  (session as unknown as SessionInternals)._handleTerminalOutput(data);
}

describe('Codex terminal output filtering', () => {
  it('strips unsolicited Codex erase-display redraws to preserve scrollback', () => {
    const session = new Session({ workingDir: '/tmp', mode: 'codex' });

    handleOutput(session, '\x1b[H\x1b[Jidle redraw');

    expect(session.terminalBuffer).toBe('\x1b[Hidle redraw');
  });

  it('preserves Codex erase-display redraw when the user pressed Ctrl+L', () => {
    const session = new Session({ workingDir: '/tmp', mode: 'codex' });

    session.write('\x0c');
    handleOutput(session, '\x1b[H\x1b[Jredraw after clear');

    expect(session.terminalBuffer).toBe('\x1b[H\x1b[Jredraw after clear');
  });

  it('clears the Codex prompt/status rows without clearing output above them', () => {
    const session = new Session({ workingDir: '/tmp', mode: 'codex' });
    (session as unknown as SessionInternals)._ptyRows = 63;

    const emitted: string[] = [];
    session.on('terminal', (data) => emitted.push(data));

    const bottomBandRedraw =
      '\x1b[48;2;42;42;42m' +
      '\x1b[60;2H\x1b[K' +
      '\x1b[61;39H\x1b[K' +
      '\x1b[62;2H\x1b[K' +
      '\x1b[52;1H\x1b[49m\x1b[2m• \x1b[1mRunning node -e ...' +
      '\x1b[60;1H\x1b[48;2;42;42;42m \r\n' +
      '\x1b[1m›\x1b[0m\x1b[48;2;42;42;42m \x1b[2mUse /skills to list available skills\r\n' +
      '\x1b[63;3H\x1b[49m\x1b[38;2;246;226;183mgpt-5.5 xhigh\x1b[39m' +
      '\x1b[2m · \x1b[38;2;242;181;144mContext 42% left\x1b[39m' +
      '\x1b[61;3H';

    handleOutput(session, bottomBandRedraw);

    expect(emitted[0]).not.toContain('\x1b[52;1H\x1b[2K');
    expect(emitted[0]).toContain('\x1b[60;1H\x1b[2K');
    expect(emitted[0]).toContain('\x1b[63;1H\x1b[2K');
    expect(emitted[0].indexOf('\x1b[60;1H\x1b[2K')).toBeLessThan(emitted[0].indexOf(bottomBandRedraw));
  });

  it('clears Codex advisory rows even when they are above the terminal bottom', () => {
    const session = new Session({ workingDir: '/tmp', mode: 'codex' });
    (session as unknown as SessionInternals)._ptyRows = 63;

    const emitted: string[] = [];
    session.on('terminal', (data) => emitted.push(data));

    const advisoryRedraw =
      '\x1b[55;1H\x1b[2mMessages\x1b[Cto\x1b[Cbe submitted\x1b[Cafter\x1b[Cnext toolcall ' +
      '(press esc to interrupt and send immediately)\x1b[56;1H';

    handleOutput(session, advisoryRedraw);

    expect(emitted[0]).toContain('\x1b[55;1H\x1b[2K');
    expect(emitted[0].indexOf('\x1b[55;1H\x1b[2K')).toBeLessThan(emitted[0].indexOf(advisoryRedraw));
  });

  it('does not clear Codex resume-picker rows just because an option is selected', () => {
    const session = new Session({ workingDir: '/tmp', mode: 'codex' });
    (session as unknown as SessionInternals)._ptyRows = 63;

    const emitted: string[] = [];
    session.on('terminal', (data) => emitted.push(data));

    const resumePickerRedraw =
      '\x1b[1;2H\x1b[36m\x1b[1mResume a previous session' +
      '\x1b[3;2H\x1b[2mType to search      Filter: \x1b[35m[Cwd]\x1b[39m\x1b[2m All' +
      '\x1b[5;3H\x1b[33m\x1b[48;2;42;42;42m\x1b[1m❯ \x1b[2m22h ago     ll' +
      '\x1b[6;3H\x1b[2m  1d ago      $kb-health' +
      '\x1b[60;1H\x1b[2m──── 2 / 2 · 100% ─' +
      '\x1b[61;1H enter resume   esc exit   ↑/↓ browse';

    handleOutput(session, resumePickerRedraw);

    expect(emitted[0]).not.toContain('\x1b[4;1H\x1b[2K');
    expect(emitted[0]).not.toContain('\x1b[5;1H\x1b[2K');
    expect(emitted[0]).toContain(resumePickerRedraw);
  });
});
