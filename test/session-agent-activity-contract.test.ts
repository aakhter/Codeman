import { describe, expect, it } from 'vitest';
import { Session } from '../src/session.js';
import type { SessionActivityProjection } from '../src/types/session.js';

type SessionContractAccess = {
  _handleTerminalOutput(data: string): void;
  _markWorking(): void;
};

function contractAccess(session: Session): SessionContractAccess {
  return session as unknown as SessionContractAccess;
}

describe('Session agent activity contract', () => {
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

    await session.writeViaMux('prompt\r');
    expect(session.terminalActivityEpoch).toBe(initialEpoch + 2);

    access._markWorking();
    expect(session.terminalActivityEpoch).toBe(initialEpoch + 3);
    access._markWorking();
    expect(session.terminalActivityEpoch).toBe(initialEpoch + 3);
  });
});
