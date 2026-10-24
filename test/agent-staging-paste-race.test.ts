/** @fileoverview Actual managed staging transport rechecks after awaited buffer creation. */
import { expect, it } from 'vitest';
import { Session } from '../src/session.js';
import { TmuxManager, formatPaneSnapshot } from '../src/tmux-manager.js';
import type { MuxSession } from '../src/mux-interface.js';
class RecordingManager extends TmuxManager {
  override isAvailable(): boolean {
    return true;
  }
  ran: string[] = [];
  enabled = true;
  afterSet: () => Promise<void> = async () => {};
  override isBracketedPasteEnabled(): boolean {
    return this.enabled;
  }
  override capturePaneBuffer(): string {
    return formatPaneSnapshot(['› ', '  GPT-6-Luna default · ~/case'], { cols: 100, rows: 20, cursorX: 2, cursorY: 0 });
  }
  protected override inputRunner() {
    return async (cmd: string) => {
      this.ran.push(cmd);
      if (cmd.includes(' set-buffer ')) await this.afterSet();
    };
  }
}
function target() {
  const mux = new RecordingManager();
  const muxSession: MuxSession = {
    sessionId: 'staged',
    muxName: 'codeman-abc12345',
    createdAt: 1,
    pid: 1,
    workingDir: '/tmp',
    mode: 'codex',
    attached: true,
  };
  mux.registerSession(muxSession);
  const session = new Session({ id: 'staged', workingDir: '/tmp', mode: 'codex', mux, muxSession });
  return { session, mux };
}
it.each(['mode', 'revision', 'lifecycle'])('never pastes LF when %s changes while filling the buffer', async (kind) => {
  const { session, mux } = target();
  mux.afterSet = async () => {
    if (kind === 'mode') mux.enabled = false;
    else if (kind === 'revision') session.trackUserInput('x');
    else
      await (session as unknown as { _withPaneLifecycle(op: () => Promise<void>): Promise<void> })._withPaneLifecycle(
        async () => {}
      );
  };
  try {
    expect(await session.stageGuardedInput('first\nsecond', true)).toBe(false);
    expect(mux.ran.some((cmd) => cmd.includes(' paste-buffer '))).toBe(false);
    expect(mux.ran.some((cmd) => cmd.includes(' delete-buffer '))).toBe(true);
  } finally {
    await session.stop(false);
    mux.destroy();
  }
});
it('preserves an authorized leading blank line instead of normalizing it in generic sendInput', async () => {
  const { session, mux } = target();
  try {
    expect(await session.stageGuardedInput('\nfirst\nsecond', true)).toBe(true);
    expect(mux.ran[0]).toContain("-- '\nfirst\nsecond'");
    expect(mux.ran).toHaveLength(2);
    expect(mux.ran[1]).toContain(' paste-buffer -p -r ');
    expect(mux.ran.some((cmd) => / Enter$/.test(cmd))).toBe(false);
  } finally {
    await session.stop(false);
    mux.destroy();
  }
});

it('tracks pasted multiline content without publishing a submission before guarded Enter', async () => {
  const { session, mux } = target();
  const submitted: string[] = [];
  session.on('promptSubmitted', (text) => submitted.push(text));
  try {
    expect(await session.stageGuardedInput('first\nsecond', true)).toBe(true);
    expect(submitted).toEqual([]);
    expect(session.lastSubmitAt).toBe(0);
    expect(session.assistantLastInputAt).toBeGreaterThan(0);
    mux.capturePaneBuffer = () =>
      formatPaneSnapshot(['› first', '  second', '  GPT-6-Luna default · ~/case'], {
        cols: 100,
        rows: 20,
        cursorX: 8,
        cursorY: 1,
      });
    expect(await session.submitGuardedInput(session.guardedInputSnapshot()!)).toBe(true);
    // Session auto-naming intentionally normalizes all whitespace in submittedPrompt events.
    expect(submitted).toEqual(['first second']);
  } finally {
    await session.stop(false);
    mux.destroy();
  }
});
