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

function backpressuredClient(options: { throwAfterBackpressure?: boolean } = {}) {
  const writes: string[] = [];
  let firstWrite = true;
  let onDrain: (() => void) | undefined;
  const raw = {
    write(chunk: string) {
      if (!firstWrite && options.throwAfterBackpressure) throw new Error('client disconnected');
      writes.push(chunk);
      if (firstWrite) {
        firstWrite = false;
        return false;
      }
      return true;
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

  it('coalesces repeated layout invalidations and drains refresh, layout, then legacy order', () => {
    const cleanup = new CleanupManager();
    const manager = new SseStreamManager({ getSessionStateWithRespawn: () => null }, cleanup);
    const blockedAlice = backpressuredClient();
    const liveAlice = client();
    const bob = client();
    const admin = client();
    manager.addClient(blockedAlice.reply, null, false, undefined, { username: 'alice', role: 'user' });
    manager.addClient(liveAlice.reply, null, false, undefined, { username: 'alice', role: 'user' });
    manager.addClient(bob.reply, null, false, undefined, { username: 'bob', role: 'user' });
    manager.addClient(admin.reply, null, false, undefined, { username: 'root', role: 'admin' });

    manager.broadcast('test:prime-backpressure', {}, { username: 'alice' });
    for (const target of [blockedAlice.writes, liveAlice.writes, bob.writes, admin.writes]) target.length = 0;

    const first = { owner: 'alice', version: 4 };
    const latest = { owner: 'alice', version: 5 };
    manager.broadcast('tab:layoutChanged', first, deriveTabLayoutSseHint(first));
    manager.broadcast('tab:layoutChanged', latest, deriveTabLayoutSseHint(latest));
    manager.broadcastSessionOrder(orderChange(['a2', 'a1']));

    expect(blockedAlice.writes).toEqual([]);
    expect(liveAlice.writes).toEqual([
      'event: tab:layoutChanged\ndata: {"owner":"alice","version":4}\n\n',
      'event: tab:layoutChanged\ndata: {"owner":"alice","version":5}\n\n',
      'event: session:orderChanged\ndata: {"order":["a2","a1"]}\n\n',
    ]);
    expect(bob.writes).toEqual([]);
    expect(admin.writes).toEqual(liveAlice.writes);

    blockedAlice.drain();

    expect(blockedAlice.writes).toEqual([
      'event: session:needsRefresh\ndata: {}\n\n',
      'event: tab:layoutChanged\ndata: {"owner":"alice","version":5}\n\n',
      'event: session:orderChanged\ndata: {"order":["a2","a1"]}\n\n',
    ]);
    cleanup.dispose();
  });

  it('clears a queued layout invalidation on disconnect and ignores its stale drain callback', () => {
    const cleanup = new CleanupManager();
    const manager = new SseStreamManager({ getSessionStateWithRespawn: () => null }, cleanup);
    const alice = backpressuredClient();
    manager.addClient(alice.reply, null, false, undefined, { username: 'alice', role: 'user' });
    manager.broadcast('test:prime-backpressure', {}, { username: 'alice' });
    alice.writes.length = 0;

    const payload = { owner: 'alice', version: 4 };
    manager.broadcast('tab:layoutChanged', payload, deriveTabLayoutSseHint(payload));
    manager.removeClient(alice.reply);
    alice.drain();

    expect(alice.writes).toEqual([]);
    expect(manager.clientCount).toBe(0);
    cleanup.dispose();
  });

  it('clears a queued layout invalidation when drain recovery fails', () => {
    const cleanup = new CleanupManager();
    const manager = new SseStreamManager({ getSessionStateWithRespawn: () => null }, cleanup);
    const alice = backpressuredClient({ throwAfterBackpressure: true });
    manager.addClient(alice.reply, null, false, undefined, { username: 'alice', role: 'user' });
    manager.broadcast('test:prime-backpressure', {}, { username: 'alice' });
    alice.writes.length = 0;

    const payload = { owner: 'alice', version: 4 };
    manager.broadcast('tab:layoutChanged', payload, deriveTabLayoutSseHint(payload));
    expect(() => alice.drain()).not.toThrow();
    alice.drain();

    expect(alice.writes).toEqual([]);
    expect(manager.clientCount).toBe(0);
    cleanup.dispose();
  });
});
