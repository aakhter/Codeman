/** @fileoverview Guarded input observes all production write and lifecycle primitives. */
import { expect, it, vi } from 'vitest';
import { formatPaneSnapshot, TmuxManager } from '../src/tmux-manager.js';
import { Session } from '../src/session.js';
import { promptSha256 } from '../src/agent-staging.js';
it('fences writes and reused-pid pane lifecycles without persisting prompt content', async () => {
  let screen = '› \n  GPT-6-Luna default · ~/case\n';
  const mux = {
    isAvailable: () => true,
    capturePaneBuffer: () =>
      formatPaneSnapshot(screen.trimEnd().split('\n'), {
        cols: 100,
        rows: 20,
        cursorX: screen.startsWith('› hello') ? 7 : 2,
        cursorY: 0,
      }),
    sendInput: async () => true,
  };
  const session = new Session({
    workingDir: '/tmp',
    mode: 'codex',
    mux,
    muxSession: { muxName: 'codeman-test', sessionId: 'test', createdAt: 1, pid: 12345 },
  } as unknown as ConstructorParameters<typeof Session>[0]);
  const before = session.guardedInputSnapshot();
  expect(before?.composerSha).toBe(promptSha256(''));
  await session.writeViaMux('hello');
  screen = '› hello\n  GPT-6-Luna default · ~/case\n';
  expect(session.guardedInputSnapshot()?.revision).toBe(before!.revision + 1);
  session.trackUserInput('x');
  expect(session.guardedInputSnapshot()?.revision).toBe(before!.revision + 2);
  await session.performAuxiliaryInput(async () => {});
  expect(session.guardedInputSnapshot()?.revision).toBe(before!.revision + 3);
  const generation = session.inspectionGeneration;
  await (session as unknown as { _withPaneLifecycle(op: () => Promise<void>): Promise<void> })._withPaneLifecycle(
    async () => {
      expect(session.guardedInputSnapshot()).toBeNull();
    }
  );
  expect(session.inspectionGeneration).not.toBe(generation);
  session.markPromptSubmitted();
  expect(session.guardedInputSnapshot()?.revision).toBe(before!.revision + 4);
  await session.stop(false);
  expect(session.guardedInputSnapshot()).toBeNull();
});
it('checks conditional Enter at the dispatch boundary and rejects concurrent browser input', async () => {
  let dispatch: (() => void) | undefined;
  const writes: string[] = [];
  const mux = {
    isAvailable: () => true,
    capturePaneBuffer: () =>
      formatPaneSnapshot(['› hello', '  GPT-6-Luna default · ~/case'], { cols: 100, rows: 20, cursorX: 7, cursorY: 0 }),
    sendInput: async (_id: string, text: string, options?: { beforeDispatch?: () => boolean }) => {
      await new Promise<void>((resolve) => {
        dispatch = resolve;
      });
      if (options?.beforeDispatch && !options.beforeDispatch()) return false;
      writes.push(text);
      return true;
    },
  };
  const session = new Session({
    workingDir: '/tmp',
    mode: 'codex',
    mux,
    muxSession: { muxName: 'codeman-test', sessionId: 'test', createdAt: 1, pid: 1 },
  } as unknown as ConstructorParameters<typeof Session>[0]);
  try {
    const expected = session.guardedInputSnapshot()!;
    const sending = session.submitGuardedInput(expected);
    expect(await session.writeViaMux('other')).toBe(false);
    dispatch!();
    expect(await sending).toBe(false);
    expect(writes).toEqual([]);
    const next = session.submitGuardedInput(session.guardedInputSnapshot()!);
    dispatch!();
    expect(await next).toBe(true);
    expect(writes).toEqual(['\r']);
    const restarting = session.submitGuardedInput(session.guardedInputSnapshot()!);
    await (session as unknown as { _withPaneLifecycle(op: () => Promise<void>): Promise<void> })._withPaneLifecycle(
      async () => {}
    );
    dispatch!();
    expect(await restarting).toBe(false);
    expect(writes).toEqual(['\r']);
    const auxiliary = session.submitGuardedInput(session.guardedInputSnapshot()!);
    await expect(
      session.performAuxiliaryInput(async () => {
        throw new Error('must not execute');
      })
    ).rejects.toThrow('Guarded submission');
    dispatch!();
    expect(await auxiliary).toBe(false);
    expect(writes).toEqual(['\r']);
  } finally {
    await session.stop(false);
  }
});

it('cancels an older automatic submit verifier before staging an identical prompt', async () => {
  vi.useFakeTimers();
  let composer = '';
  const writes: string[] = [];
  const mux = {
    isAvailable: () => true,
    capturePaneBuffer: () =>
      formatPaneSnapshot([`› ${composer}`, '  GPT-6-Luna default · ~/case'], {
        cols: 100,
        rows: 20,
        cursorX: 2 + composer.length,
        cursorY: 0,
      }),
    capturePaneText: () => `› ${composer}\n  GPT-6-Luna default · ~/case`,
    sendInput: async (_id: string, text: string) => {
      writes.push(text);
      composer += text;
      return true;
    },
  };
  const session = new Session({
    workingDir: '/tmp',
    mode: 'codex',
    mux,
    muxSession: { muxName: 'codeman-test', sessionId: 'test', createdAt: 1, pid: 1 },
  } as unknown as ConstructorParameters<typeof Session>[0]);
  try {
    session.verifySubmitted('hello');
    expect(await session.stageGuardedInput('hello')).toBe(true);
    await vi.advanceTimersByTimeAsync(2000);
    expect(writes).toEqual(['hello']);
  } finally {
    await session.stop(false);
    vi.useRealTimers();
  }
});

it('refuses checkpoint input during a guarded submit and invalidates its delayed Enter', async () => {
  let release!: () => void;
  const writes: string[] = [];
  const mux = {
    isAvailable: () => true,
    capturePaneBuffer: () =>
      formatPaneSnapshot(['› hello', '  GPT-6-Luna default · ~/case'], { cols: 100, rows: 20, cursorX: 7, cursorY: 0 }),
    sendInput: async (_id: string, text: string, options?: { beforeDispatch?: () => boolean }) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      if (options?.beforeDispatch && !options.beforeDispatch()) return false;
      writes.push(text);
      return true;
    },
    sendCheckpointCommand: async (_id: string, text: string) => {
      writes.push(text);
      return { ok: true as const, attempt: 1 };
    },
  };
  const session = new Session({
    workingDir: '/tmp',
    mode: 'codex',
    mux,
    muxSession: { muxName: 'codeman-test', sessionId: 'test', createdAt: 1, pid: 1 },
  } as unknown as ConstructorParameters<typeof Session>[0]);
  try {
    const submitting = session.submitGuardedInput(session.guardedInputSnapshot()!);
    expect(await session.writeCheckpointViaMux('/compact\r')).toMatchObject({ ok: false, stage: 'text' });
    release();
    expect(await submitting).toBe(false);
    expect(writes).toEqual([]);
  } finally {
    await session.stop(false);
  }
});

it('counts the whole checkpoint pending window and invalidates earlier receipt revisions', async () => {
  let release!: () => void;
  const mux = {
    isAvailable: () => true,
    capturePaneBuffer: () =>
      formatPaneSnapshot(['› hello', '  GPT-6-Luna default · ~/case'], { cols: 100, rows: 20, cursorX: 7, cursorY: 0 }),
    sendCheckpointCommand: async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { ok: true as const, attempt: 1 };
    },
  };
  const session = new Session({
    workingDir: '/tmp',
    mode: 'codex',
    mux,
    muxSession: { muxName: 'codeman-test', sessionId: 'test', createdAt: 1, pid: 1 },
  } as unknown as ConstructorParameters<typeof Session>[0]);
  try {
    const before = session.guardedInputSnapshot()!;
    const checkpoint = session.writeCheckpointViaMux('/compact\r');
    expect(session.assistantPendingWrites).toBe(1);
    expect(session.guardedInputSnapshot()).toBeNull();
    expect(await session.submitGuardedInput(before)).toBe(false);
    release();
    expect(await checkpoint).toMatchObject({ ok: true });
    expect(session.assistantPendingWrites).toBe(0);
    expect(session.guardedInputSnapshot()?.revision).toBe(before.revision + 1);
    expect(await session.submitGuardedInput(before)).toBe(false);
  } finally {
    await session.stop(false);
  }
});

it.each(['/new', '/clear'])(
  'rechecks input/lifecycle after awaited %s attribution before checkpoint dispatch',
  async (command) => {
    let release!: (ids: string[]) => void;
    const writes: string[] = [];
    const mux = {
      isAvailable: () => true,
      capturePaneBuffer: () =>
        formatPaneSnapshot(['› hello', '  GPT-6-Luna default · ~/case'], {
          cols: 100,
          rows: 20,
          cursorX: 7,
          cursorY: 0,
        }),
      sendInput: async (_id: string, text: string) => {
        writes.push(text);
        return true;
      },
      sendCheckpointCommand: async (_id: string, text: string) => {
        writes.push(text);
        return { ok: true as const, attempt: 1 };
      },
    };
    const session = new Session({
      workingDir: '/tmp',
      mode: 'codex',
      mux,
      muxSession: { muxName: 'codeman-test', sessionId: 'test', createdAt: 1, pid: 1 },
    } as unknown as ConstructorParameters<typeof Session>[0]);
    (
      session as unknown as { _findRecentOwnedCodexConversationIds(): Promise<string[]> }
    )._findRecentOwnedCodexConversationIds = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    try {
      const checkpoint = session.writeCheckpointViaMux(command + '\r');
      expect(session.assistantPendingWrites).toBe(1);
      expect(session.guardedInputSnapshot()).toBeNull();
      await session.writeViaMux('other');
      release([]);
      expect(await checkpoint).toMatchObject({ ok: false, stage: 'text' });
      expect(writes).toEqual(['other']);
      expect(session.assistantPendingWrites).toBe(0);
    } finally {
      await session.stop(false);
    }
  }
);

it('routes automatic verifier Enter through the shared guarded input boundary', async () => {
  vi.useFakeTimers();
  let release!: () => void;
  const writes: string[] = [];
  const mux = {
    isAvailable: () => true,
    capturePaneBuffer: () =>
      formatPaneSnapshot(['› hello', '  GPT-6-Luna default · ~/case'], { cols: 100, rows: 20, cursorX: 7, cursorY: 0 }),
    capturePaneText: () => '› hello\n  GPT-6-Luna default · ~/case',
    sendInput: async (_id: string, text: string, options?: { beforeDispatch?: () => boolean }) => {
      if (options?.beforeDispatch) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        if (!options.beforeDispatch()) return false;
      }
      writes.push(text);
      return true;
    },
  };
  const session = new Session({
    workingDir: '/tmp',
    mode: 'codex',
    mux,
    muxSession: { muxName: 'codeman-test', sessionId: 'test', createdAt: 1, pid: 1 },
  } as unknown as ConstructorParameters<typeof Session>[0]);
  try {
    session.verifySubmitted('hello');
    const submission = session.submitGuardedInput(session.guardedInputSnapshot()!);
    await vi.advanceTimersByTimeAsync(2000);
    release();
    expect(await submission).toBe(false);
    await vi.advanceTimersByTimeAsync(60000);
    expect(writes).toEqual([]);
  } finally {
    await session.stop(false);
    vi.useRealTimers();
  }
});

it('refuses legacy one-shot prompt entrypoints during a guarded submission before spawning', async () => {
  let release!: () => void;
  const writes: string[] = [];
  const mux = {
    isAvailable: () => true,
    capturePaneBuffer: () =>
      formatPaneSnapshot(['› hello', '  GPT-6-Luna default · ~/case'], { cols: 100, rows: 20, cursorX: 7, cursorY: 0 }),
    sendInput: async (_id: string, text: string, options?: { beforeDispatch?: () => boolean }) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      if (options?.beforeDispatch && !options.beforeDispatch()) return false;
      writes.push(text);
      return true;
    },
  };
  const session = new Session({
    workingDir: '/tmp',
    mode: 'codex',
    mux,
    muxSession: { muxName: 'codeman-test', sessionId: 'test', createdAt: 1, pid: 1 },
  } as unknown as ConstructorParameters<typeof Session>[0]);
  const access = session as unknown as { ptyProcess: { write(data: string): void } | null };
  try {
    const submission = session.submitGuardedInput(session.guardedInputSnapshot()!);
    // This also prevents a real spawn if the lease guard regresses.
    access.ptyProcess = {
      write: () => {
        throw new Error('must not write');
      },
    };
    await expect(session.runPrompt('other')).rejects.toThrow('Guarded submission');
    await expect(session.sendInput('other')).rejects.toThrow('Guarded submission');
    access.ptyProcess = null;
    release();
    expect(await submission).toBe(false);
    expect(writes).toEqual([]);
  } finally {
    access.ptyProcess = null;
    await session.stop(false);
  }
});

it('enforces Session checkpoint revision guards between the real mux text and Enter stages', async () => {
  let release!: () => void;
  const commands: string[] = [];
  const mux = new TmuxManager({
    checkpointDelayMs: 0,
    checkpointExecutor: async (command) => {
      commands.push(command);
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    },
  });
  const metadata = {
    muxName: 'codeman-c0d529ab',
    sessionId: 'guard-checkpoint',
    createdAt: 1,
    pid: 1,
    workingDir: '/tmp',
    mode: 'codex' as const,
    attached: true,
  };
  mux.registerSession(metadata);
  vi.spyOn(mux, 'capturePaneBuffer').mockReturnValue(
    formatPaneSnapshot(['› hello', '  GPT-6-Luna default · ~/case'], { cols: 100, rows: 20, cursorX: 7, cursorY: 0 })
  );
  const session = new Session({ id: metadata.sessionId, workingDir: '/tmp', mode: 'codex', mux, muxSession: metadata });
  try {
    const checkpoint = session.writeCheckpointViaMux('/compact\r');
    expect(commands).toHaveLength(1);
    await session.writeViaMux('intervening input');
    release();
    expect(await checkpoint).toMatchObject({ ok: false, stage: 'enter' });
    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain('/compact');
    expect(session.assistantPendingWrites).toBe(0);
  } finally {
    await session.stop(false);
    mux.destroy();
  }
});

it('stages authorized multiline only with bracketed paste enabled and never emits Enter', async () => {
  let enabled = false;
  const writes: string[] = [];
  const mux = {
    isAvailable: () => true,
    isBracketedPasteEnabled: () => enabled,
    capturePaneBuffer: () =>
      formatPaneSnapshot(['› ', '  GPT-6-Luna default · ~/case'], { cols: 100, rows: 20, cursorX: 2, cursorY: 0 }),
    sendInput: async (_id: string, value: string) => {
      writes.push(value);
      return true;
    },
    sendGuardedText: async (_id: string, value: string, eligible: () => boolean) => {
      if (!eligible()) return false;
      writes.push(value);
      return true;
    },
  };
  const session = new Session({
    workingDir: '/tmp',
    mode: 'codex',
    mux,
    muxSession: { muxName: 'codeman-test', sessionId: 'test', createdAt: 1, pid: 1 },
  } as unknown as ConstructorParameters<typeof Session>[0]);
  try {
    expect(await session.stageGuardedInput('first\nsecond', true)).toBe(false);
    enabled = true;
    expect(await session.stageGuardedInput('first\nsecond')).toBe(false);
    expect(await session.stageGuardedInput('first\nsecond', true)).toBe(true);
    expect(writes).toEqual(['first\nsecond']);
  } finally {
    await session.stop(false);
  }
});

it('uses capability-selected Claude verification and exact multiline hash', async () => {
  const screen = formatPaneSnapshot(
    ['────────────────', '❯ first', '  second', '────────────────', '  ⏵⏵ bypass permissions on (shift+tab to cycle)'],
    { cols: 100, rows: 20, cursorX: 8, cursorY: 2 }
  );
  const mux = { isAvailable: () => true, capturePaneBuffer: () => screen };
  const session = new Session({
    workingDir: '/tmp',
    mode: 'claude',
    mux,
    muxSession: { muxName: 'codeman-test', sessionId: 'test', createdAt: 1, pid: 1 },
  } as unknown as ConstructorParameters<typeof Session>[0]);
  try {
    expect(session.guardedInputSnapshot()?.composerSha).toBe(promptSha256('first\nsecond'));
  } finally {
    await session.stop(false);
  }
});
