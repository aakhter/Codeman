import { afterEach, describe, expect, it, vi } from 'vitest';

const { spawn } = vi.hoisted(() => ({
  spawn: vi.fn(() => ({
    pid: 1234,
    onData: vi.fn(),
    onExit: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
  })),
}));

vi.mock('node-pty', () => ({ spawn }));

import { Session } from '../src/session.js';

describe('Session idle reasons', () => {
  afterEach(() => {
    vi.useRealTimers();
    spawn.mockClear();
  });

  it('labels the shell startup timer as shell-ready', async () => {
    vi.useFakeTimers();
    const session = new Session({ workingDir: '/tmp', mode: 'shell' });
    const idleEvents: Array<{ reason?: string }> = [];
    session.on('idle', (info?: { reason?: string }) => idleEvents.push(info ?? {}));

    await session.startShell();
    vi.advanceTimersByTime(500);

    expect(idleEvents).toEqual([{ reason: 'shell-ready' }]);
    vi.useRealTimers();
    await session.stop();
  });
});
