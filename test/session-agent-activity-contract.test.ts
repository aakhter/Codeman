import { describe, expect, it, vi } from 'vitest';
import { Session } from '../src/session.js';
import type { SessionActivityProjection } from '../src/types/session.js';

type SessionContractAccess = {
  _handleTerminalOutput(data: string): void;
  _markWorking(): void;
  _findRecentOwnedCodexConversationIds: () => Promise<string[]>;
  _autoOps: { readonly activeCheckpointRunId: string | undefined };
  _mux: {
    sendInput?: ReturnType<typeof vi.fn>;
    sendCheckpointCommand?: ReturnType<typeof vi.fn>;
  } | null;
  _muxSession: { muxName: string } | null;
  ptyProcess: { write: ReturnType<typeof vi.fn> } | null;
};

function contractAccess(session: Session): SessionContractAccess {
  return session as unknown as SessionContractAccess;
}

describe('Session agent activity contract', () => {
  it('emits terminalActivity when delivered input advances the activity epoch', () => {
    const session = new Session({ id: 'activity-input-event', workingDir: '/tmp', mode: 'claude' });
    contractAccess(session).ptyProcess = { write: vi.fn() };
    const observed = vi.fn();
    session.on('terminalActivity', observed);

    expect(session.write('continue\r')).toBe(true);

    expect(observed).toHaveBeenCalledTimes(1);
  });

  it('stores a runtime-only activity projection without changing raw status helpers', () => {
    const session = new Session({ workingDir: '/tmp', mode: 'claude' });
    const projection: SessionActivityProjection = {
      activityStatus: 'waiting_agents',
      activityStatusSince: 123,
    };

    session.setActivityProjection(projection);
    projection.activityStatusSince = 999;

    expect(session.activityProjection).toEqual({
      activityStatus: 'waiting_agents',
      activityStatusSince: 123,
    });
    expect(session.isIdle()).toBe(true);
    expect(session.isBusy()).toBe(false);
    expect(session.isWorking).toBe(false);
  });

  it('clears the derived timestamp when the projection leaves an agent-activity state', () => {
    const session = new Session({ workingDir: '/tmp', mode: 'claude' });

    session.setActivityProjection({
      activityStatus: 'idle',
      activityStatusSince: 123,
    });

    expect(session.activityProjection.activityStatusSince).toBeNull();
  });

  it('preserves one timestamp across checking/waiting projections until leaving the derived episode', () => {
    const session = new Session({ workingDir: '/tmp', mode: 'claude' });
    session.setActivityProjection({ activityStatus: 'checking_agents', activityStatusSince: 100 });
    session.setActivityProjection({ activityStatus: 'waiting_agents', activityStatusSince: 200 });
    expect(session.activityProjection.activityStatusSince).toBe(100);

    session.setActivityProjection(
      { activityStatus: 'waiting_agents', activityStatusSince: 50 },
      { reconstructEpisode: true }
    );
    expect(session.activityProjection.activityStatusSince).toBe(50);

    session.setActivityProjection({ activityStatus: 'idle', activityStatusSince: null });
    session.setActivityProjection({ activityStatus: 'checking_agents', activityStatusSince: 300 });
    expect(session.activityProjection.activityStatusSince).toBe(300);
  });

  it('does not include runtime activity fields in persisted session state', () => {
    const session = new Session({ workingDir: '/tmp', mode: 'claude' });
    session.setActivityProjection({
      activityStatus: 'checking_agents',
      activityStatusSince: 456,
    });

    expect(session.toState()).not.toHaveProperty('activityStatus');
    expect(session.toState()).not.toHaveProperty('activityStatusSince');
    expect(session.toState()).not.toHaveProperty('terminalActivityEpoch');
  });

  it('advances the terminal activity epoch on output, submission, and working transitions', async () => {
    const session = new Session({ workingDir: '/tmp', mode: 'claude' });
    const access = contractAccess(session);
    const initialEpoch = session.terminalActivityEpoch;

    access._handleTerminalOutput('output');
    expect(session.terminalActivityEpoch).toBe(initialEpoch + 1);

    access.ptyProcess = { write: vi.fn() };
    await session.writeViaMux('prompt\r');
    expect(session.terminalActivityEpoch).toBe(initialEpoch + 2);

    access._markWorking();
    expect(session.terminalActivityEpoch).toBe(initialEpoch + 3);
    access._markWorking();
    expect(session.terminalActivityEpoch).toBe(initialEpoch + 3);
  });

  it('advances the terminal activity epoch when output is buffered as an incomplete CSI sequence', () => {
    const session = new Session({ workingDir: '/tmp', mode: 'claude' });
    const initialEpoch = session.terminalActivityEpoch;

    contractAccess(session)._handleTerminalOutput('\x1b[?104');

    expect(session.terminalActivityEpoch).toBe(initialEpoch + 1);
  });

  it('does not advance submission activity when no terminal transport exists', async () => {
    const session = new Session({ workingDir: '/tmp', mode: 'claude' });
    const initialEpoch = session.terminalActivityEpoch;

    expect(session.write('direct\r')).toBe(false);
    expect(await session.writeViaMux('mux\r')).toBe(false);

    expect(session.terminalActivityEpoch).toBe(initialEpoch);
    expect(session.lastSubmitAt).toBe(0);
  });

  it('does not advance submission activity when direct or mux delivery fails', async () => {
    const direct = new Session({ workingDir: '/tmp', mode: 'claude' });
    contractAccess(direct).ptyProcess = {
      write: vi.fn(() => {
        throw new Error('direct write failed');
      }),
    };
    expect(() => direct.write('prompt\r')).toThrow('direct write failed');
    expect(direct.terminalActivityEpoch).toBe(0);
    expect(direct.lastSubmitAt).toBe(0);

    const mux = new Session({ workingDir: '/tmp', mode: 'claude' });
    const muxAccess = contractAccess(mux);
    muxAccess._mux = { sendInput: vi.fn(async () => false) };
    muxAccess._muxSession = { muxName: 'codeman-failed-input-contract' };
    expect(await mux.writeViaMux('prompt\r')).toBe(false);
    expect(mux.terminalActivityEpoch).toBe(0);
    expect(mux.lastSubmitAt).toBe(0);
  });

  it('does not advance submission activity for cancelled or failed ordinary checkpoints', async () => {
    const cancelled = new Session({ workingDir: '/tmp', mode: 'claude' });
    let activeRunRead = 0;
    contractAccess(cancelled)._autoOps = {
      get activeCheckpointRunId() {
        return activeRunRead++ === 0 ? 'run-before' : 'run-after';
      },
    };
    expect(await cancelled.writeCheckpointViaMux('/compact\r')).toMatchObject({
      ok: false,
      error: 'checkpoint run cancelled before delivery',
    });
    expect(cancelled.terminalActivityEpoch).toBe(0);
    expect(cancelled.lastSubmitAt).toBe(0);

    const failed = new Session({ workingDir: '/tmp', mode: 'claude' });
    const failedAccess = contractAccess(failed);
    failedAccess._mux = {
      sendCheckpointCommand: vi.fn(async () => ({
        ok: false as const,
        stage: 'enter' as const,
        error: 'checkpoint delivery failed',
        attempt: 1,
      })),
    };
    failedAccess._muxSession = { muxName: 'codeman-failed-checkpoint-contract' };
    expect(await failed.writeCheckpointViaMux('/compact\r')).toMatchObject({ ok: false });
    expect(failed.terminalActivityEpoch).toBe(0);
    expect(failed.lastSubmitAt).toBe(0);
  });

  it('advances the epoch for a delivered Codex checkpoint command without changing viewer submit time', async () => {
    const session = new Session({ workingDir: '/tmp', mode: 'codex' });
    const access = contractAccess(session);
    const sendCheckpointCommand = vi.fn(async () => ({ ok: true as const, attempt: 1 }));
    access._findRecentOwnedCodexConversationIds = async () => [];
    access._mux = { sendCheckpointCommand };
    access._muxSession = { muxName: 'codeman-checkpoint-contract' };
    const initialEpoch = session.terminalActivityEpoch;

    expect(await session.writeCheckpointViaMux('/clear\r')).toEqual({ ok: true, attempt: 1 });

    expect(sendCheckpointCommand).toHaveBeenCalledOnce();
    expect(session.terminalActivityEpoch).toBe(initialEpoch + 1);
    expect(session.lastSubmitAt).toBe(0);
  });

  it('does not advance the epoch when a Codex checkpoint is cancelled before delivery', async () => {
    const session = new Session({ workingDir: '/tmp', mode: 'codex' });
    const access = contractAccess(session);
    let resolveSnapshot!: (ids: string[]) => void;
    access._findRecentOwnedCodexConversationIds = () =>
      new Promise<string[]>((resolve) => {
        resolveSnapshot = resolve;
      });
    let activeRunRead = 0;
    access._autoOps = {
      get activeCheckpointRunId() {
        return activeRunRead++ === 0 ? 'run-before' : 'run-after';
      },
    };
    const sendCheckpointCommand = vi.fn(async () => ({ ok: true as const, attempt: 1 }));
    access._mux = { sendCheckpointCommand };
    access._muxSession = { muxName: 'codeman-cancelled-checkpoint-contract' };
    const initialEpoch = session.terminalActivityEpoch;

    const delivery = session.writeCheckpointViaMux('/new\r');
    resolveSnapshot([]);

    expect(await delivery).toMatchObject({ ok: false, error: 'checkpoint run cancelled before delivery' });
    expect(sendCheckpointCommand).not.toHaveBeenCalled();
    expect(session.terminalActivityEpoch).toBe(initialEpoch);
  });

  it('does not advance the epoch when Codex checkpoint transport reports failure', async () => {
    const session = new Session({ workingDir: '/tmp', mode: 'codex' });
    const access = contractAccess(session);
    access._findRecentOwnedCodexConversationIds = async () => [];
    access._mux = {
      sendCheckpointCommand: vi.fn(async () => ({
        ok: false as const,
        stage: 'enter' as const,
        error: 'checkpoint delivery failed',
        attempt: 1,
      })),
    };
    access._muxSession = { muxName: 'codeman-failed-codex-checkpoint-contract' };

    expect(await session.writeCheckpointViaMux('/new\r')).toMatchObject({ ok: false });
    expect(session.terminalActivityEpoch).toBe(0);
    expect(session.lastSubmitAt).toBe(0);
  });
});
