/** @fileoverview Minimal tab-layout SSE payload routing to owner plus admins. */
import type { FastifyReply } from 'fastify';
import { describe, expect, it } from 'vitest';
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
});
