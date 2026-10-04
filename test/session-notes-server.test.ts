import { afterEach, describe, expect, it, vi } from 'vitest';
import { Session } from '../src/session.js';
import { WebServer } from '../src/web/server.js';
import type { SessionNotesPort } from '../src/web/ports/session-notes-port.js';
import { sessionNotesOwnerKey } from '../src/session-notes-projects.js';

// This integration test must never launch or query a real terminal multiplexer.
vi.mock('../src/mux-factory.js', () => ({ createMultiplexer: () => ({ on: () => {}, getSessions: () => [] }) }));

afterEach(() => vi.unstubAllEnvs());
describe('server notebook trust boundaries', () => {
  it('registers notebook routes and resolves only exact owner sources, including admins', async () => {
    vi.stubEnv('CODEMAN_MULTIUSER', '1');
    const server = new WebServer(3999, false, true) as unknown as {
      sessions: Map<string, Session>;
      createRouteContext(): SessionNotesPort;
      setupRoutes(): Promise<void>;
      app: { close(): Promise<void>; inject(url: string): Promise<{ statusCode: number }> };
      sessionNotes: { close(): void };
    };
    const source = new Session({ workingDir: '/tmp', owner: 'alice', useMux: false });
    server.sessions.set(source.id, source);
    const ctx = server.createRouteContext();
    expect(await ctx.getNotesSource(source.id, 'alice')).toMatchObject({ id: source.id, owner: 'alice' });
    expect(await ctx.getNotesSource(source.id, 'root')).toBeNull();
    vi.stubEnv('CODEMAN_MULTIUSER', '0');
    await server.setupRoutes();
    expect((await server.app.inject('/api/session-notes')).statusCode).toBe(200);
    expect((await server.app.inject('/api/v1/session-notes')).statusCode).toBe(200);
    await server.app.close();
    server.sessionNotes.close();
  });
  it('uses strict hashed owner routing for notes notifications', () => {
    const server = new WebServer(3999, false, true) as unknown as {
      deriveSseHint(event: string, data: unknown): unknown;
      sessionNotes: { close(): void };
    };
    expect(server.deriveSseHint('notes:changed', { ownerKey: sessionNotesOwnerKey('alice') })).toEqual({
      strictOwnerKey: sessionNotesOwnerKey('alice'),
    });
    expect(server.deriveSseHint('notes:changed', {})).toEqual({ strictOwnerKey: 'unresolved' });
    server.sessionNotes.close();
  });
});
