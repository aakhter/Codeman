/** @fileoverview WebServer session registration coordination with the owner tab-layout queue. */

import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { WebServer } from '../src/web/server.js';

function harness() {
  const server = Object.create(WebServer.prototype) as {
    sessions: Map<string, object>;
    attachAgentActivity: ReturnType<typeof vi.fn>;
    detachAgentActivity: ReturnType<typeof vi.fn>;
    reconcileWatcherConversation: ReturnType<typeof vi.fn>;
    tabLayouts: { sessionCreated: ReturnType<typeof vi.fn> };
    registerSessionWithLayout(session: object): Promise<unknown>;
  };
  server.sessions = new Map();
  server.attachAgentActivity = vi.fn();
  server.detachAgentActivity = vi.fn();
  server.reconcileWatcherConversation = vi.fn(async () => undefined);
  server.tabLayouts = { sessionCreated: vi.fn() };
  return server;
}

describe('WebServer layout-aware session registration', () => {
  it('attaches activity and publishes the session map only inside the owner layout transaction', async () => {
    const server = harness();
    const session = { id: 'scheduled-1', owner: 'alice' };
    server.tabLayouts.sessionCreated.mockImplementation(
      async (_owner: string, _id: string, _options: object, register: () => void) => {
        expect(server.sessions.has(session.id)).toBe(false);
        register();
        expect(server.sessions.get(session.id)).toBe(session);
        return { layout: { version: 0 }, placements: [] };
      }
    );

    await expect(server.registerSessionWithLayout(session)).resolves.toMatchObject({ placements: [] });
    expect(server.attachAgentActivity).toHaveBeenCalledWith(session);
    expect(server.reconcileWatcherConversation).toHaveBeenCalledWith(session);
    expect(server.sessions.get(session.id)).toBe(session);
  });

  it('rolls back the map and activity attachment when watcher or layout registration fails', async () => {
    const watcherFailure = harness();
    const watcherSession = { id: 'watcher-failure', owner: 'alice' };
    watcherFailure.reconcileWatcherConversation.mockRejectedValueOnce(new Error('watcher failed'));
    await expect(watcherFailure.registerSessionWithLayout(watcherSession)).rejects.toThrow('watcher failed');
    expect(watcherFailure.detachAgentActivity).toHaveBeenCalledWith(watcherSession);
    expect(watcherFailure.sessions.has(watcherSession.id)).toBe(false);

    const layoutFailure = harness();
    const layoutSession = { id: 'layout-failure', owner: 'alice' };
    layoutFailure.tabLayouts.sessionCreated.mockImplementation(
      async (_owner: string, _id: string, _options: object, register: () => void) => {
        register();
        throw new Error('layout failed');
      }
    );
    await expect(layoutFailure.registerSessionWithLayout(layoutSession)).rejects.toThrow('layout failed');
    expect(layoutFailure.sessions.has(layoutSession.id)).toBe(false);
    expect(layoutFailure.detachAgentActivity).toHaveBeenCalledWith(layoutSession);
  });

  it('routes legacy scheduled-loop sessions through the same layout-aware helper', () => {
    const source = readFileSync(new URL('../src/web/server.ts', import.meta.url), 'utf8');
    const scheduledLoop = source.slice(
      source.indexOf('private async runScheduledLoop'),
      source.indexOf('// Run the prompt')
    );

    expect(scheduledLoop).toContain('await this.registerSessionWithLayout(session)');
    expect(scheduledLoop).not.toContain('this.sessions.set(session.id, session)');
  });
});
