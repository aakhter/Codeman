import { describe, expect, it } from 'vitest';
import { sessionOrderForStatus } from '../src/web/session-order-status.js';

describe('sessionOrderForStatus', () => {
  const persisted = {
    a1: { owner: 'alice' },
    a2: { owner: 'alice' },
    b1: { owner: 'bob' },
    moved: { owner: 'alice' },
  };
  const live = new Map([
    ['moved', { owner: 'bob' }],
    ['live-a', { owner: 'alice' }],
  ]);
  const globalOrder = ['b1', 'a2', 'unknown', 'moved', 'a1', 'live-a'];

  it('returns a defensive global order for single-user and admin status', () => {
    const single = sessionOrderForStatus(globalOrder, persisted, live, undefined, false);
    const admin = sessionOrderForStatus(globalOrder, persisted, live, { username: 'root', role: 'admin' }, true);

    expect(single).toEqual(globalOrder);
    expect(admin).toEqual(globalOrder);
    expect(single).not.toBe(globalOrder);
    expect(admin).not.toBe(globalOrder);
  });

  it('filters regular status with live ownership overriding persisted ownership', () => {
    expect(sessionOrderForStatus(globalOrder, persisted, live, { username: 'alice', role: 'user' }, true)).toEqual([
      'a2',
      'a1',
      'live-a',
    ]);
  });
});
