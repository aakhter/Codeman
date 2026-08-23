/** @fileoverview Trusted recipient selection for legacy session-order SSE compatibility. */
import type { FastifyReply } from 'fastify';
import { describe, expect, it } from 'vitest';
import type { SessionOrderProjectionChange } from '../src/tab-layout-service.js';
import { CleanupManager } from '../src/utils/index.js';
import { sessionOrderPayloadFor } from '../src/web/session-order-sse.js';
import { SseStreamManager } from '../src/web/sse-stream-manager.js';

function changeWith(
  changedOwnerOrders: Record<string, string[]>,
  globalOrder: string[],
  globalChanged: boolean
): SessionOrderProjectionChange {
  return { changedOwnerOrders, globalOrder, globalChanged };
}

function client() {
  const writes: string[] = [];
  return {
    writes,
    reply: { raw: { write: (chunk: string) => (writes.push(chunk), true) } } as unknown as FastifyReply,
  };
}

describe('legacy session-order SSE routing', () => {
  it('selects an owner slice for the matching regular user and nothing for another user', () => {
    const change = changeWith({ alice: ['a2', 'a1'] }, ['a2', 'b1', 'a1'], true);
    expect(sessionOrderPayloadFor({ username: 'alice', role: 'user' }, change)).toEqual({ order: ['a2', 'a1'] });
    expect(sessionOrderPayloadFor({ username: 'bob', role: 'user' }, change)).toBeUndefined();
  });

  it('selects the global projection for admins even when only interleaving changed', () => {
    const change = changeWith({}, ['b1', 'a1'], true);
    expect(sessionOrderPayloadFor({ username: 'admin', role: 'admin' }, change)).toEqual({ order: ['b1', 'a1'] });
  });

  it('uses the global projection for identity-less single-user clients', () => {
    const change = changeWith({ '@single': ['s2', 's1'] }, ['s2', 's1'], true);
    expect(sessionOrderPayloadFor(undefined, change)).toEqual({ order: ['s2', 's1'] });
  });

  it('delivers owner slices to every matching device, the global order to admins, and nothing to other users', () => {
    const cleanup = new CleanupManager();
    const manager = new SseStreamManager({ getSessionStateWithRespawn: () => null }, cleanup);
    const alicePhone = client();
    const aliceDesktop = client();
    const bob = client();
    const admin = client();
    manager.addClient(alicePhone.reply, null, false, undefined, { username: 'alice', role: 'user' });
    manager.addClient(aliceDesktop.reply, null, false, undefined, { username: 'alice', role: 'user' });
    manager.addClient(bob.reply, null, false, undefined, { username: 'bob', role: 'user' });
    manager.addClient(admin.reply, null, false, undefined, { username: 'root', role: 'admin' });

    manager.broadcastSessionOrder(changeWith({ alice: ['a2', 'a1'] }, ['a2', 'b1', 'a1'], true));

    const ownerFrame = 'event: session:orderChanged\ndata: {"order":["a2","a1"]}\n\n';
    expect(alicePhone.writes).toEqual([ownerFrame]);
    expect(aliceDesktop.writes).toEqual([ownerFrame]);
    expect(bob.writes).toEqual([]);
    expect(admin.writes).toEqual(['event: session:orderChanged\ndata: {"order":["a2","b1","a1"]}\n\n']);
    cleanup.dispose();
  });

  it('delivers a global-only interleaving change to admins only', () => {
    const cleanup = new CleanupManager();
    const manager = new SseStreamManager({ getSessionStateWithRespawn: () => null }, cleanup);
    const alice = client();
    const admin = client();
    manager.addClient(alice.reply, null, false, undefined, { username: 'alice', role: 'user' });
    manager.addClient(admin.reply, null, false, undefined, { username: 'root', role: 'admin' });

    manager.broadcastSessionOrder(changeWith({}, ['b1', 'a1'], true));

    expect(alice.writes).toEqual([]);
    expect(admin.writes).toEqual(['event: session:orderChanged\ndata: {"order":["b1","a1"]}\n\n']);
    cleanup.dispose();
  });
});
