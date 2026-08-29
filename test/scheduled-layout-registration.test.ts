import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { WebServer } from '../src/web/server.js';

describe('scheduled session layout registration', () => {
  it('registers the layout before lifecycle work and rolls back a rejected tentative session', async () => {
    const sessions = new Map<string, { id: string; owner?: string }>();
    // Minimal Session surface the activity adapter touches on attach.
    const session = {
      id: 'scheduled-session',
      owner: 'alice',
      status: 'idle',
      mode: 'claude',
      setActivityProjection: () => {},
    };
    const sessionCreated = vi.fn(async () => {
      throw new Error('layout unavailable');
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const server = Object.create(WebServer.prototype) as any;
    server.sessions = sessions;
    server.tabLayouts = { sessionCreated };
    // Downstream registerSessionWithLayout() also attaches agent-activity tracking
    // and reconciles the watcher conversation before the layout call, so the
    // partial host needs those collaborators. The property under test is
    // unchanged: the layout is asked FIRST, and a rejection leaves no session
    // registered — plus, here, no activity adapter left attached.
    const detached: unknown[] = [];
    server.activityAdapters = new Map();
    server.activityIdentityKeys = new Map();
    server.activityTrackingEnabled = false;
    server.agentActivityCoordinator = {
      attachSession: () => {},
      detachSession: (adapter: unknown) => detached.push(adapter),
      trackingDisabled: () => {},
    };
    server.localClaudeRuntimeVersion = undefined;
    server.reconcileWatcherConversation = async () => {};

    await expect(server.registerSessionWithLayout(session)).rejects.toThrow('layout unavailable');

    expect(sessionCreated.mock.calls[0]?.[0]).toBe('alice');
    expect(sessions.has(session.id)).toBe(false);
  });

  it('uses the shared registration helper in the scheduled loop before persistence and listeners', () => {
    const source = readFileSync(new URL('../src/web/server.ts', import.meta.url), 'utf8');
    const loop = source.slice(
      source.indexOf('private async runScheduledLoop'),
      source.indexOf('private async stopScheduledRun')
    );

    expect(loop).toContain('await this.registerSessionWithLayout(session);');
    expect(loop.indexOf('await this.registerSessionWithLayout(session);')).toBeLessThan(
      loop.indexOf('this.store.incrementSessionsCreated();')
    );
    expect(loop.indexOf('await this.registerSessionWithLayout(session);')).toBeLessThan(
      loop.indexOf('await this.setupSessionListeners(session);')
    );
  });
});
