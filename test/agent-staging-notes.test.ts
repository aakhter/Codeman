/** @fileoverview Notes share guarded input fences without changing literal paste delivery. */
import { expect, it, vi } from 'vitest';
import { Session } from '../src/session.js';
import { formatPaneSnapshot, TmuxManager } from '../src/tmux-manager.js';

function target() {
  let composer = 'hello';
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
    sendInput: vi.fn(async (_id: string, text: string, options?: { beforeDispatch?: () => boolean }) => {
      if (options?.beforeDispatch && !options.beforeDispatch()) return false;
      writes.push(text);
      composer += text;
      return true;
    }),
    sendNotesInput: vi.fn(async (_id: string, text: string, eligible: () => boolean) => {
      if (!eligible()) return false;
      writes.push(text, '\r');
      return true;
    }),
  };
  const session = new Session({
    id: 'notes-id',
    workingDir: '/tmp',
    mode: 'codex',
    mux,
    muxSession: { muxName: 'codeman-12345678', sessionId: 'notes-id', createdAt: 1, pid: 123 },
  } as unknown as ConstructorParameters<typeof Session>[0]);
  return { session, mux, writes };
}

it('refuses notes during a guarded lease and invalidates its delayed Enter', async () => {
  const { session, mux, writes } = target();
  let release!: () => void;
  mux.sendInput.mockImplementation(async (_id, text, options) => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    if (!options?.beforeDispatch?.()) return false;
    writes.push(text);
    return true;
  });
  try {
    const submitting = session.submitGuardedInput(session.guardedInputSnapshot()!);
    expect(await session.writeNotesInput('notes')).toBe(false);
    release();
    expect(await submitting).toBe(false);
    expect(mux.sendNotesInput).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  } finally {
    release?.();
    await session.stop(false);
  }
});

it('counts pending notes before awaiting transport and invalidates older receipt revisions on failure', async () => {
  const { session, mux } = target();
  let release!: () => void;
  mux.sendNotesInput.mockImplementation(async () => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return false;
  });
  try {
    const before = session.guardedInputSnapshot()!;
    const notes = session.writeNotesInput('notes');
    expect(session.assistantPendingWrites).toBe(1);
    expect(session.guardedInputSnapshot()).toBeNull();
    expect(await session.submitGuardedInput(before)).toBe(false);
    release();
    expect(await notes).toBe(false);
    expect(session.assistantPendingWrites).toBe(0);
    expect(session.guardedInputSnapshot()?.revision).toBeGreaterThan(before.revision);
    expect(await session.submitGuardedInput(before)).toBe(false);
  } finally {
    release?.();
    await session.stop(false);
  }
});

it.each([true, false])(
  'fences notes after an acknowledged=%s guarded draft until explicit input or lifecycle recovery',
  async (acknowledged) => {
    const { session, mux, writes } = target();
    mux.sendInput.mockResolvedValue(acknowledged);
    try {
      expect(await session.stageGuardedInput('draft')).toBe(acknowledged);
      expect(await session.writeNotesInput('notes')).toBe(false);
      expect(await session.writeNotesInput('notes retry')).toBe(false);
      expect(mux.sendNotesInput).not.toHaveBeenCalled();
      await session.writeViaMux('explicit edit');
      expect(await session.writeNotesInput('notes after edit')).toBe(true);
      await session.stageGuardedInput('another draft');
      await (session as unknown as { _withPaneLifecycle(op: () => Promise<void>): Promise<void> })._withPaneLifecycle(
        async () => {}
      );
      expect(await session.writeNotesInput('notes after restart')).toBe(true);
      expect(writes).toEqual(['notes after edit', '\r', 'notes after restart', '\r']);
    } finally {
      await session.stop(false);
    }
  }
);

it.each(['input', 'stage', 'lifecycle', 'owner', 'assistant'] as const)(
  'rechecks %s before a delayed notes paste and Enter',
  async (change) => {
    for (const boundary of ['paste', 'enter'] as const) {
      const { session, mux, writes } = target();
      let release!: () => void;
      mux.sendNotesInput.mockImplementation(async (_id, text, eligible) => {
        if (boundary === 'enter') {
          if (!eligible()) return false;
          writes.push(text);
        }
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        if (!eligible()) return false;
        if (boundary === 'paste') writes.push(text);
        writes.push('\r');
        return true;
      });
      try {
        const sending = session.writeNotesInput('notes');
        if (change === 'input') await session.writeViaMux('edit');
        if (change === 'stage') expect(await session.stageGuardedInput('draft')).toBe(false);
        if (change === 'lifecycle')
          await (
            session as unknown as { _withPaneLifecycle(op: () => Promise<void>): Promise<void> }
          )._withPaneLifecycle(async () => {});
        if (change === 'owner') {
          session.owner = 'other';
          session.owner = undefined;
        }
        if (change === 'assistant') session.setAssistantInputGuard(() => false);
        release();
        expect(await sending).toBe(false);
        expect(writes).not.toContain('\r');
        expect(writes).not.toContain('draft');
        if (boundary === 'paste') expect(writes).not.toContain('notes');
        expect(session.assistantPendingWrites).toBe(0);
      } finally {
        release?.();
        await session.stop(false);
      }
    }
  }
);

it('refuses notes before transport when assistant input or the pane lifecycle is locked', async () => {
  const { session, mux } = target();
  try {
    session.setAssistantInputGuard(() => false);
    expect(await session.writeNotesInput('notes')).toBe(false);
    session.setAssistantInputGuard(() => true);
    await (session as unknown as { _withPaneLifecycle(op: () => Promise<void>): Promise<void> })._withPaneLifecycle(
      async () => {
        expect(await session.writeNotesInput('notes')).toBe(false);
      }
    );
    expect(mux.sendNotesInput).not.toHaveBeenCalled();
  } finally {
    await session.stop(false);
  }
});

it('uses real notes adapter checks between literal paste and Enter on a lifecycle change', async () => {
  let release!: () => void;
  const commands: string[][] = [];
  const manager = new TmuxManager({
    notesDelayMs: 0,
    notesExecutor: async (_file, args) => {
      commands.push(args);
      if (commands.length === 1)
        await new Promise<void>((resolve) => {
          release = resolve;
        });
    },
  });
  manager.registerSession({
    sessionId: 'notes-id',
    muxName: 'codeman-12345678',
    pid: 123,
    createdAt: Date.now(),
    workingDir: '/tmp',
    mode: 'codex',
    attached: false,
  });
  const session = new Session({
    id: 'notes-id',
    workingDir: '/tmp',
    mode: 'codex',
    mux: manager,
    muxSession: manager.getSession('notes-id'),
  } as unknown as ConstructorParameters<typeof Session>[0]);
  try {
    const sending = session.writeNotesInput("literal ' $(text)\r\nnext  ");
    await (session as unknown as { _withPaneLifecycle(op: () => Promise<void>): Promise<void> })._withPaneLifecycle(
      async () => {}
    );
    release();
    expect(await sending).toBe(false);
    expect(commands).toHaveLength(1);
    expect(commands[0].at(-1)).toBe("\x1b[200~literal ' $(text)\r\nnext  \x1b[201~");
  } finally {
    release?.();
    await session.stop(false);
    manager.destroy();
  }
});

it.each([true, false])(
  'releases the draft notes fence only after acknowledged=%s guarded Enter',
  async (acknowledged) => {
    const { session, mux } = target();
    try {
      expect(await session.stageGuardedInput('draft')).toBe(true);
      const snapshot = session.guardedInputSnapshot()!;
      mux.sendInput.mockImplementation(async (_id, _text, options) => {
        expect(options?.beforeDispatch?.()).toBe(true);
        return acknowledged;
      });
      expect(await session.submitGuardedInput(snapshot)).toBe(acknowledged);
      expect(await session.writeNotesInput('notes')).toBe(acknowledged);
      expect(mux.sendNotesInput).toHaveBeenCalledTimes(acknowledged ? 1 : 0);
    } finally {
      await session.stop(false);
    }
  }
);

it('protects the whole pending stage window and keeps its fence after a transport exception', async () => {
  const { session, mux } = target();
  let release!: () => void;
  mux.sendInput.mockImplementation(async () => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    throw Error('lost stage acknowledgement');
  });
  try {
    const staging = session.stageGuardedInput('draft');
    const rejected = expect(staging).rejects.toThrow('lost stage acknowledgement');
    expect(session.assistantPendingWrites).toBe(1);
    expect(await session.writeNotesInput('notes')).toBe(false);
    release();
    await rejected;
    expect(session.assistantPendingWrites).toBe(0);
    expect(await session.writeNotesInput('notes retry')).toBe(false);
    expect(mux.sendNotesInput).not.toHaveBeenCalled();
  } finally {
    release?.();
    await session.stop(false);
  }
});
