/** @fileoverview Owner-routed saved-webview invalidation coverage. */
import { readFileSync } from 'node:fs';
import type { FastifyReply } from 'fastify';
import { describe, expect, it } from 'vitest';
import { CleanupManager } from '../src/utils/index.js';
import { SseEvent } from '../src/web/sse-events.js';
import { SseStreamManager } from '../src/web/sse-stream-manager.js';
import { deriveWebviewSseHint } from '../src/web/webview-sse.js';

function client() {
  const writes: string[] = [];
  return {
    writes,
    reply: { raw: { write: (chunk: string) => (writes.push(chunk), true) } } as unknown as FastifyReply,
  };
}

describe('saved webview SSE routing', () => {
  it('registers the event and derives an exact fail-closed owner hint', () => {
    expect(SseEvent.WebviewChanged).toBe('webview:changed');
    expect(deriveWebviewSseHint({ action: 'updated', id: 'w1', owner: 'alice' })).toEqual({
      username: 'alice',
      sessionScoped: true,
    });
    expect(deriveWebviewSseHint({ action: 'updated', id: 'w1' })).toEqual({
      username: undefined,
      sessionScoped: true,
    });
  });

  it('delivers owner invalidations to that owner and admins, never another ordinary user', () => {
    const cleanup = new CleanupManager();
    const manager = new SseStreamManager({ getSessionStateWithRespawn: () => null }, cleanup);
    const alice = client();
    const bob = client();
    const admin = client();
    manager.addClient(alice.reply, null, false, undefined, { username: 'alice', role: 'user' });
    manager.addClient(bob.reply, null, false, undefined, { username: 'bob', role: 'user' });
    manager.addClient(admin.reply, null, false, undefined, { username: 'root', role: 'admin' });
    const payload = { action: 'deleted', id: 'w1', owner: 'alice' };

    manager.broadcast(SseEvent.WebviewChanged, payload, deriveWebviewSseHint(payload));

    expect(alice.writes).toEqual(['event: webview:changed\ndata: {"action":"deleted","id":"w1","owner":"alice"}\n\n']);
    expect(admin.writes).toEqual(alice.writes);
    expect(bob.writes).toEqual([]);
    cleanup.dispose();
  });

  it('wires the webview family through the server hint derivation', () => {
    const server = readFileSync(new URL('../src/web/server.ts', import.meta.url), 'utf8');
    expect(server).toContain("event.startsWith('webview:')");
    expect(server).toContain('deriveWebviewSseHint(data)');
  });
});
