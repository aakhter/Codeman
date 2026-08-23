/** @fileoverview Trusted recipient selection and backpressure recovery for legacy session-order SSE. */

import type { FastifyReply } from 'fastify';
import { describe, expect, it } from 'vitest';
import type { SessionOrderProjectionChange } from '../src/tab-layout-service.js';
import { CleanupManager } from '../src/utils/index.js';
import { sessionOrderPayloadFor } from '../src/web/session-order-sse.js';
import { SseStreamManager } from '../src/web/sse-stream-manager.js';

const change = (
  changedOwnerOrders: Record<string, string[]>,
  globalOrder: string[],
  globalChanged: boolean
): SessionOrderProjectionChange => ({ changedOwnerOrders, globalOrder, globalChanged });

function client() {
  const writes: string[] = [];
  return {
    writes,
    reply: { raw: { write: (chunk: string) => (writes.push(chunk), true) } } as unknown as FastifyReply,
  };
}

function backpressuredClient(options: { throwAfterBackpressure?: boolean } = {}) {
  const writes: string[] = [];
  let first = true;
  let drainCallback: (() => void) | undefined;
  let failNext = false;
  const raw = {
    write(chunk: string) {
      if (!first && options.throwAfterBackpressure) throw new Error('client disconnected');
      writes.push(chunk);
      if (failNext || first) {
        failNext = false;
        first = false;
        return false;
      }
      return true;
    },
    once(event: string, callback: () => void) {
      if (event === 'drain') drainCallback = callback;
      return raw;
    },
  };
  return {
    writes,
    reply: { raw } as unknown as FastifyReply,
    backpressureNext: () => {
      failNext = true;
    },
    drain: () => {
      const callback = drainCallback;
      drainCallback = undefined;
      callback?.();
    },
  };
}

describe('legacy session-order SSE routing', () => {
  it('selects owner slices, skips inherited keys, and gives admins the global projection', () => {
    const update = change({ alice: ['a2', 'a1'] }, ['a2', 'b1', 'a1'], true);
    expect(sessionOrderPayloadFor({ username: 'alice', role: 'user' }, update)).toEqual({ order: ['a2', 'a1'] });
    expect(sessionOrderPayloadFor({ username: 'bob', role: 'user' }, update)).toBeUndefined();
    expect(sessionOrderPayloadFor({ username: 'constructor', role: 'user' }, update)).toBeUndefined();
    expect(sessionOrderPayloadFor({ username: 'root', role: 'admin' }, update)).toEqual({
      order: ['a2', 'b1', 'a1'],
    });
    expect(sessionOrderPayloadFor(undefined, update)).toEqual({ order: ['a2', 'b1', 'a1'] });
  });

  it('sends global-only interleaving changes to admins and identity-less clients only', () => {
    const cleanup = new CleanupManager();
    const manager = new SseStreamManager({ getSessionStateWithRespawn: () => null }, cleanup);
    const alice = client();
    const admin = client();
    const singleUser = client();
    manager.addClient(alice.reply, null, false, undefined, { username: 'alice', role: 'user' });
    manager.addClient(admin.reply, null, false, undefined, { username: 'root', role: 'admin' });
    manager.addClient(singleUser.reply, null, false);

    manager.broadcastSessionOrder(change({}, ['b1', 'a1'], true));

    expect(alice.writes).toEqual([]);
    expect(admin.writes).toEqual(['event: session:orderChanged\ndata: {"order":["b1","a1"]}\n\n']);
    expect(singleUser.writes).toEqual(admin.writes);
    cleanup.dispose();
  });

  it('delivers owner slices to all matching devices, the global order to admins, and nothing to other users', () => {
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

    manager.broadcastSessionOrder(change({ alice: ['a2', 'a1'] }, ['a2', 'b1', 'a1'], true));

    const ownerFrame = 'event: session:orderChanged\ndata: {"order":["a2","a1"]}\n\n';
    expect(alicePhone.writes).toEqual([ownerFrame]);
    expect(aliceDesktop.writes).toEqual([ownerFrame]);
    expect(bob.writes).toEqual([]);
    expect(admin.writes).toEqual(['event: session:orderChanged\ndata: {"order":["a2","b1","a1"]}\n\n']);
    cleanup.dispose();
  });

  it('coalesces the latest order and drains refresh, every owner layout, then final order across partial backpressure', () => {
    const cleanup = new CleanupManager();
    const manager = new SseStreamManager({ getSessionStateWithRespawn: () => null }, cleanup);
    const alice = backpressuredClient();
    manager.addClient(alice.reply, null, false, undefined, { username: 'alice', role: 'user' });
    manager.broadcast('prime', {}, { owner: 'alice' });
    alice.writes.length = 0;

    manager.broadcast('tab:layoutChanged', { owner: 'alice', version: 4 }, { owner: 'alice' });
    manager.broadcast('tab:layoutChanged', { owner: 'bob', version: 5 }, { owner: 'alice' });
    manager.broadcastSessionOrder(change({ alice: ['a2', 'a1'] }, ['a2', 'a1'], true));
    manager.broadcastSessionOrder(change({ alice: ['a1', 'a2'] }, ['a1', 'a2'], true));

    alice.backpressureNext();
    alice.drain();
    expect(alice.writes).toEqual(['event: session:needsRefresh\ndata: {}\n\n']);

    alice.drain();
    expect(alice.writes).toEqual([
      'event: session:needsRefresh\ndata: {}\n\n',
      'event: session:needsRefresh\ndata: {}\n\n',
      'event: tab:layoutChanged\ndata: {"owner":"alice","version":4}\n\n',
      'event: tab:layoutChanged\ndata: {"owner":"bob","version":5}\n\n',
      'event: session:orderChanged\ndata: {"order":["a1","a2"]}\n\n',
    ]);
    cleanup.dispose();
  });

  it('clears pending frames on replacement and ignores stale drain callbacks', () => {
    const cleanup = new CleanupManager();
    const manager = new SseStreamManager({ getSessionStateWithRespawn: () => null }, cleanup);
    const old = backpressuredClient();
    const replacement = client();
    manager.addClient(old.reply, null, false, 'device', { username: 'alice', role: 'user' });
    manager.broadcast('prime', {}, { owner: 'alice' });
    old.writes.length = 0;
    manager.broadcastSessionOrder(change({ alice: ['a2', 'a1'] }, ['a2', 'a1'], true));

    manager.addClient(replacement.reply, null, false, 'device', { username: 'alice', role: 'user' });
    old.drain();

    expect(old.writes).toEqual([]);
    expect(manager.clientCount).toBe(1);
    cleanup.dispose();
  });

  it('clears queued order state on disconnect and isolates drain write failures', () => {
    const cleanup = new CleanupManager();
    const manager = new SseStreamManager({ getSessionStateWithRespawn: () => null }, cleanup);
    const disconnected = backpressuredClient();
    const broken = backpressuredClient({ throwAfterBackpressure: true });
    const healthy = client();
    manager.addClient(disconnected.reply, null, false, undefined, { username: 'alice', role: 'user' });
    manager.addClient(broken.reply, null, false, undefined, { username: 'alice', role: 'user' });
    manager.addClient(healthy.reply, null, false, undefined, { username: 'alice', role: 'user' });
    manager.broadcast('prime', {}, { owner: 'alice' });
    for (const writes of [disconnected.writes, broken.writes, healthy.writes]) writes.length = 0;
    manager.broadcastSessionOrder(change({ alice: ['a2', 'a1'] }, ['a2', 'a1'], true));

    manager.removeClient(disconnected.reply);
    disconnected.drain();
    expect(disconnected.writes).toEqual([]);
    expect(() => broken.drain()).not.toThrow();
    expect(manager.clientCount).toBe(1);

    manager.broadcastSessionOrder(change({ alice: ['a1', 'a2'] }, ['a1', 'a2'], true));
    expect(healthy.writes.at(-1)).toBe('event: session:orderChanged\ndata: {"order":["a1","a2"]}\n\n');
    cleanup.dispose();
  });
});
