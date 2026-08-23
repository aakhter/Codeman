/** @fileoverview Minimal tab-layout SSE payload routing to owner plus admins. */
import type { FastifyReply } from 'fastify';
import { describe, expect, it } from 'vitest';
import type { SessionOrderProjectionChange } from '../src/tab-layout-service.js';
import { CleanupManager } from '../src/utils/index.js';
import { SseStreamManager } from '../src/web/sse-stream-manager.js';
import { deriveTabLayoutSseHint } from '../src/web/tab-layout-sse.js';

function client() {
  const writes: string[] = [];
  return {
    writes,
    reply: { raw: { write: (chunk: string) => (writes.push(chunk), true) } } as unknown as FastifyReply,
  };
}

function scriptedBackpressuredClient(outcomes: Array<boolean | Error>) {
  const writes: string[] = [];
  let onDrain: (() => void) | undefined;
  const raw = {
    write(chunk: string) {
      const outcome = outcomes.shift() ?? true;
      if (outcome instanceof Error) throw outcome;
      writes.push(chunk);
      return outcome;
    },
    once(event: string, callback: () => void) {
      if (event === 'drain') onDrain = callback;
      return raw;
    },
  };
  return {
    writes,
    reply: { raw } as unknown as FastifyReply,
    drain: () => {
      const callback = onDrain;
      onDrain = undefined;
      callback?.();
    },
  };
}

const orderChange = (order: string[]): SessionOrderProjectionChange => ({
  changedOwnerOrders: { alice: order },
  globalOrder: order,
  globalChanged: true,
});

describe('tab layout SSE routing', () => {
  it('derives an exact owner hint with fail-closed session scoping', () => {
    expect(deriveTabLayoutSseHint({ owner: 'alice', version: 4 })).toEqual({
      username: 'alice',
      sessionScoped: true,
    });
  });

  it('delivers the minimal event to the owner and admins, but not another user', () => {
    const cleanup = new CleanupManager();
    const manager = new SseStreamManager({ getSessionStateWithRespawn: () => null }, cleanup);
    const alice = client();
    const bob = client();
    const admin = client();
    manager.addClient(alice.reply, null, false, undefined, { username: 'alice', role: 'user' });
    manager.addClient(bob.reply, null, false, undefined, { username: 'bob', role: 'user' });
    manager.addClient(admin.reply, null, false, undefined, { username: 'root', role: 'admin' });

    const payload = { owner: 'alice', version: 4 };
    manager.broadcast('tab:layoutChanged', payload, deriveTabLayoutSseHint(payload));

    expect(alice.writes).toEqual(['event: tab:layoutChanged\ndata: {"owner":"alice","version":4}\n\n']);
    expect(admin.writes).toEqual(alice.writes);
    expect(bob.writes).toEqual([]);
    cleanup.dispose();
  });

  it('coalesces every admin-visible owner and drains layouts before the final order', () => {
    const cleanup = new CleanupManager();
    const manager = new SseStreamManager({ getSessionStateWithRespawn: () => null }, cleanup);
    const blockedAdmin = scriptedBackpressuredClient([false, true, true, true, true]);
    const alice = client();
    manager.addClient(blockedAdmin.reply, null, false, undefined, { username: 'root', role: 'admin' });
    manager.addClient(alice.reply, null, false, undefined, { username: 'alice', role: 'user' });
    manager.broadcast('prime', {}, { adminOnly: true });
    blockedAdmin.writes.length = 0;

    for (const payload of [
      { owner: 'alice', version: 4 },
      { owner: 'bob', version: 8 },
      { owner: 'alice', version: 5 },
    ]) {
      manager.broadcast('tab:layoutChanged', payload, deriveTabLayoutSseHint(payload));
    }
    manager.broadcastSessionOrder(orderChange(['a2', 'a1']));
    blockedAdmin.drain();

    expect(blockedAdmin.writes).toEqual([
      'event: session:needsRefresh\ndata: {}\n\n',
      'event: tab:layoutChanged\ndata: {"owner":"alice","version":5}\n\n',
      'event: tab:layoutChanged\ndata: {"owner":"bob","version":8}\n\n',
      'event: session:orderChanged\ndata: {"order":["a2","a1"]}\n\n',
    ]);
    expect(alice.writes).toEqual([
      'event: tab:layoutChanged\ndata: {"owner":"alice","version":4}\n\n',
      'event: tab:layoutChanged\ndata: {"owner":"alice","version":5}\n\n',
      'event: session:orderChanged\ndata: {"order":["a2","a1"]}\n\n',
    ]);
    cleanup.dispose();
  });

  it('retains later owners and final order after a layout recovery write re-enters backpressure', () => {
    const cleanup = new CleanupManager();
    const manager = new SseStreamManager({ getSessionStateWithRespawn: () => null }, cleanup);
    const admin = scriptedBackpressuredClient([false, true, false, true, true, true]);
    manager.addClient(admin.reply, null, false, undefined, { username: 'root', role: 'admin' });
    manager.broadcast('prime', {}, { adminOnly: true });
    admin.writes.length = 0;
    const alice = { owner: 'alice', version: 5 };
    const bob = { owner: 'bob', version: 8 };
    manager.broadcast('tab:layoutChanged', alice, deriveTabLayoutSseHint(alice));
    manager.broadcast('tab:layoutChanged', bob, deriveTabLayoutSseHint(bob));
    manager.broadcastSessionOrder(orderChange(['a2', 'a1']));

    admin.drain();
    expect(admin.writes).toEqual([
      'event: session:needsRefresh\ndata: {}\n\n',
      'event: tab:layoutChanged\ndata: {"owner":"alice","version":5}\n\n',
    ]);
    admin.drain();
    expect(admin.writes.slice(2)).toEqual([
      'event: session:needsRefresh\ndata: {}\n\n',
      'event: tab:layoutChanged\ndata: {"owner":"bob","version":8}\n\n',
      'event: session:orderChanged\ndata: {"order":["a2","a1"]}\n\n',
    ]);
    cleanup.dispose();
  });

  it('drops recovery state after write failure and ignores stale drain callbacks after disconnect', () => {
    const cleanup = new CleanupManager();
    const manager = new SseStreamManager({ getSessionStateWithRespawn: () => null }, cleanup);
    const broken = scriptedBackpressuredClient([false, true, new Error('gone')]);
    const disconnected = scriptedBackpressuredClient([false]);
    const healthy = client();
    manager.addClient(broken.reply, null, false, undefined, { username: 'root', role: 'admin' });
    manager.addClient(disconnected.reply, null, false, undefined, { username: 'alice', role: 'user' });
    manager.addClient(healthy.reply, null, false, undefined, { username: 'root', role: 'admin' });
    manager.broadcast('prime', {}, { adminOnly: true });
    manager.broadcast('prime', {}, { owner: 'alice' });
    for (const writes of [broken.writes, disconnected.writes, healthy.writes]) writes.length = 0;
    const payload = { owner: 'alice', version: 4 };
    manager.broadcast('tab:layoutChanged', payload, deriveTabLayoutSseHint(payload));
    manager.broadcastSessionOrder(orderChange(['a1']));

    manager.removeClient(disconnected.reply);
    disconnected.drain();
    expect(disconnected.writes).toEqual([]);
    expect(() => broken.drain()).not.toThrow();
    expect(manager.clientCount).toBe(1);
    expect(healthy.writes).toEqual([
      'event: tab:layoutChanged\ndata: {"owner":"alice","version":4}\n\n',
      'event: session:orderChanged\ndata: {"order":["a1"]}\n\n',
    ]);
    cleanup.dispose();
  });
});
