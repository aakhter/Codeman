import { describe, expect, it } from 'vitest';
import type { FastifyReply } from 'fastify';
import { SseStreamManager } from '../src/web/sse-stream-manager.js';
import { CleanupManager } from '../src/utils/cleanup-manager.js';
import { sessionNotesOwnerKey } from '../src/session-notes-projects.js';

describe('private notebook SSE', () => {
  it('delivers only to exact owner, excluding foreign admins and identity-less clients', () => {
    const cleanup = new CleanupManager();
    const manager = new SseStreamManager({ getSessionStateWithRespawn: () => null }, cleanup);
    const clients = ['alice', 'bob', 'root', undefined].map((username) => {
      const writes: string[] = [];
      const reply = { raw: { write: (s: string) => writes.push(s) } } as unknown as FastifyReply;
      manager.addClient(
        reply,
        null,
        false,
        undefined,
        username ? { username, role: username === 'root' ? 'admin' : 'user' } : undefined
      );
      return writes;
    });
    manager.broadcast('notes:changed', {}, { strictOwnerKey: sessionNotesOwnerKey('alice') });
    expect(clients.map((writes) => writes.length)).toEqual([1, 0, 0, 0]);
    manager.broadcast('notes:changed', {}, { strictOwnerKey: sessionNotesOwnerKey('root') });
    expect(clients.map((writes) => writes.length)).toEqual([1, 0, 1, 0]);
    manager.broadcast('notes:changed', {}, { strictOwnerKey: sessionNotesOwnerKey() });
    expect(clients.map((writes) => writes.length)).toEqual([1, 0, 1, 1]);
    cleanup.dispose();
  });
});
