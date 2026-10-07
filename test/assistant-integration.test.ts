import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createUser, updateUser, invalidateUsersCache } from '../src/user-store.js';
import { randomUUID } from 'node:crypto';
import { AssistantStore } from '../src/assistant-store.js';
import { AssistantRegistry, type AssistantSession } from '../src/assistant-registry.js';
import { registerAssistantRoutes } from '../src/web/routes/assistant-routes.js';
import { registerAuthMiddleware } from '../src/web/middleware/auth.js';
import { installRouteErrorHandler } from '../src/web/route-error-handler.js';

let root: string;
let store: AssistantStore;
let registry: AssistantRegistry;
let app: FastifyInstance;
const sessions = new Map<string, AssistantSession>();
let oldMultiUser: string | undefined;
let oldDataDir: string | undefined;
let oldPassword: string | undefined;
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'assistant-test-'));
  store = new AssistantStore(join(root, 'data', 'assistants.json'));
  registry = new AssistantRegistry(store);
  oldMultiUser = process.env.CODEMAN_MULTIUSER;
  oldDataDir = process.env.CODEMAN_DATA_DIR;
  process.env.CODEMAN_DATA_DIR = join(root, 'users');
  delete process.env.CODEMAN_MULTIUSER;
  invalidateUsersCache();
  oldPassword = process.env.CODEMAN_PASSWORD;
  delete process.env.CODEMAN_PASSWORD;
  sessions.clear();
  app = Fastify();
  installRouteErrorHandler(app);
  registerAuthMiddleware(app, false, '', store);
  registerAssistantRoutes(app, registry, sessions);
  app.all('/api/sessions/:id/input', async () => ({ dangerous: true }));
  app.get('/api/settings', async () => ({ dangerous: true }));
  await app.ready();
});
afterEach(async () => {
  await app.close();
  if (oldMultiUser === undefined) delete process.env.CODEMAN_MULTIUSER;
  else process.env.CODEMAN_MULTIUSER = oldMultiUser;
  if (oldDataDir === undefined) delete process.env.CODEMAN_DATA_DIR;
  else process.env.CODEMAN_DATA_DIR = oldDataDir;
  invalidateUsersCache();
  rmSync(root, { recursive: true, force: true });
  if (oldPassword === undefined) delete process.env.CODEMAN_PASSWORD;
  else process.env.CODEMAN_PASSWORD = oldPassword;
});
function session(home: string, cwd = root): AssistantSession {
  return {
    id: 'pane-test',
    mode: 'codex',
    workingDir: cwd,
    status: 'idle',
    pid: 123,
    getCodexHomeOverride: () => home,
    hasLostCodexProviderCredentials: () => false,
  };
}
function rollout(home: string, id: string, cwd: string, originator = 'codeman_pane-test') {
  mkdirSync(join(home, 'sessions'), { recursive: true });
  writeFileSync(
    join(home, 'sessions', `rollout-${id}.jsonl`),
    JSON.stringify({ type: 'session_meta', payload: { id, cwd, originator } }) + '\n'
  );
}
describe('assistant metadata and exact binding', () => {
  it('persists only token hashes, uses private files, and revokes across restart', () => {
    const a = registry.create(undefined, 'Brain', 'brain');
    const issued = store.issueToken(a, 'telegram', ['read', 'submit']);
    a.name = 'Mutated caller';
    issued.metadata.scopes.push('cancel');
    expect(store.get(a.id)?.name).toBe('Brain');
    expect(store.authenticate(issued.token)?.scopes).toEqual(['read', 'submit']);
    const disk = readFileSync(join(root, 'data', 'assistants.json'), 'utf8');
    expect(disk).not.toContain(issued.token);
    expect(statSync(join(root, 'data', 'assistants.json')).mode & 0o777).toBe(0o600);
    expect(statSync(join(root, 'data')).mode & 0o777).toBe(0o700);
    const restarted = new AssistantStore(join(root, 'data', 'assistants.json'));
    expect(restarted.authenticate(issued.token)?.assistantId).toBe(a.id);
    expect(restarted.listTokens(a.id)[0]).not.toHaveProperty('hash');
    restarted.revokeToken(a.id, issued.metadata.id);
    expect(new AssistantStore(join(root, 'data', 'assistants.json')).authenticate(issued.token)).toBeUndefined();
  });
  it('preserves corrupt state and rejects stale revisions', () => {
    const a = registry.create(undefined, 'Brain', 'brain');
    registry.update(a, 1, { name: 'Brain 2' });
    expect(() => registry.update(a, 1, { name: 'Stale' })).toThrow(/revision/);
    writeFileSync(join(root, 'data', 'assistants.json'), '{broken');
    const restarted = new AssistantStore(join(root, 'data', 'assistants.json'));
    expect(() => restarted.list()).toThrow(/unavailable/);
    expect(readFileSync(join(root, 'data', 'assistants.json'), 'utf8')).toBe('{broken');
  });
  it('binds only the exact owned conversation and rejects duplication or ambiguity', async () => {
    const a = registry.create(undefined, 'Brain', 'brain');
    const home = join(root, 'codex');
    const id = randomUUID();
    rollout(home, id, root);
    rollout(home, randomUUID(), root, 'codeman_someone-else');
    const live = session(home);
    const bound = await registry.bind(a, 1, 0, live);
    expect(bound.binding).toMatchObject({ conversationId: id, generation: 1, codexHome: home });
    const b = registry.create(undefined, 'Other', 'other');
    await expect(registry.bind(b, 1, 0, live)).rejects.toThrow(/already bound/);
    rollout(home, randomUUID(), root);
    await expect(registry.bind(bound, 2, 1, live)).rejects.toThrow(/ambiguous/);
    live.nativeResumeId = id;
    live.codexConfig = { resumeSessionId: randomUUID() };
    await expect(registry.bind(bound, 2, 1, live)).rejects.toThrow(/ambiguous/);
  });
  it('refuses cwd guesses, remote workers, other owners, and outstanding requests', async () => {
    const a = registry.create('alice', 'Brain', 'brain');
    const home = join(root, 'codex');
    rollout(home, randomUUID(), root, 'other');
    const live = { ...session(home), owner: 'alice' };
    await expect(registry.bind(a, 1, 0, live)).rejects.toThrow(/ambiguous/);
    live.remote = {};
    await expect(registry.bind(a, 1, 0, live)).rejects.toThrow(/local/);
    live.owner = 'bob';
    await expect(registry.bind(a, 1, 0, live)).rejects.toThrow(/ownership/);
    const guarded = new AssistantRegistry(store, () => true);
    live.owner = 'alice';
    await expect(guarded.bind(a, 1, 0, live)).rejects.toThrow(/outstanding/);
  });
});
describe('assistant routes through the common auth middleware', () => {
  it('uses the live user grant and rejects disabled, password-reset, or missing owners', async () => {
    process.env.CODEMAN_MULTIUSER = '1';
    await createUser({ username: 'admin', role: 'admin', password: 'test-password' });
    await createUser({ username: 'alice', role: 'user', password: 'test-password' });
    const a = registry.create('alice', 'Brain', 'brain');
    registry.create('admin', 'Other', 'other');
    const token = store.issueToken(a, 'telegram', ['read']).token;
    const headers = { authorization: `bearer ${token}` };
    const list = await app.inject({ url: '/api/assistants', headers });
    expect(list.statusCode).toBe(200);
    expect(list.json().data.assistants.map((v: { id: string }) => v.id)).toEqual([a.id]);
    await updateUser('alice', { disabled: true });
    expect((await app.inject({ url: '/api/assistants', headers })).statusCode).toBe(401);
    await updateUser('alice', { disabled: false, mustChangePassword: true });
    expect((await app.inject({ url: '/api/assistants', headers })).statusCode).toBe(401);
    const missing = registry.create('missing', 'Missing', 'missing');
    expect(
      (
        await app.inject({
          url: '/api/assistants',
          headers: { authorization: `Bearer ${store.issueToken(missing, 'missing', ['read']).token}` },
        })
      ).statusCode
    ).toBe(401);
  });
  it('atomically removes disabled metadata and revokes associated tokens', async () => {
    const a = registry.create(undefined, 'Brain', 'brain');
    const token = store.issueToken(a, 'telegram', ['read']).token;
    const result = await app.inject({
      method: 'DELETE',
      url: `/api/assistants/${a.id}`,
      payload: { expectedRevision: 1 },
    });
    expect(result.statusCode).toBe(200);
    expect(store.authenticate(token)).toBeUndefined();
    expect(new AssistantStore(join(root, 'data', 'assistants.json')).list()).toEqual([]);
  });
  it('scopes bearer access even when password auth is disabled and hides other assistants', async () => {
    const a = registry.create(undefined, 'Brain', 'brain');
    const b = registry.create(undefined, 'Other', 'other');
    const { token } = store.issueToken(a, 'telegram', ['read', 'submit']);
    const headers = { authorization: `Bearer ${token}` };
    const list = await app.inject({ url: '/api/assistants', headers });
    expect(list.json().data.assistants.map((v: { id: string }) => v.id)).toEqual([a.id]);
    expect(list.headers['cache-control']).toBe('no-store');
    for (const url of ['/api/settings', `/api/assistants/${b.id}`, `/api/assistants/${a.id}/tokens`]) {
      expect((await app.inject({ url, headers })).statusCode).toBe(403);
    }
    expect(
      (await app.inject({ method: 'POST', url: '/api/sessions/pane/input', headers, payload: { data: 'bad\r' } }))
        .statusCode
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/api/assistants/${a.id}`,
          headers,
          payload: { expectedRevision: 1, enabled: true },
        })
      ).statusCode
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/assistants/${a.id}/requests`,
          headers,
          payload: { text: 'hello', idempotencyKey: 'valid-key-123456789' },
        })
      ).statusCode
    ).toBe(503);
    expect(
      (await app.inject({ url: '/api/assistants', headers: { authorization: 'Bearer invalid' } })).statusCode
    ).toBe(401);
  });
  it('enforces individual scopes and invalidates owner tokens on mode changes', async () => {
    const a = registry.create(undefined, 'Brain', 'brain');
    const { token } = store.issueToken(a, 'read-only', ['read']);
    const headers = { authorization: `Bearer ${token}` };
    expect((await app.inject({ method: 'POST', url: `/api/assistants/${a.id}/requests`, headers })).statusCode).toBe(
      403
    );
    expect(
      (await app.inject({ method: 'POST', url: `/api/assistant-requests/${randomUUID()}/cancel`, headers })).statusCode
    ).toBe(403);
    const owned = registry.create('alice', 'Private', 'private');
    const ownedToken = store.issueToken(owned, 'private', ['read']).token;
    expect(
      (await app.inject({ url: '/api/assistants', headers: { authorization: `Bearer ${ownedToken}` } })).statusCode
    ).toBe(401);
  });
  it('requires explicit binding, validates strict bodies, and reports engine capability', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/assistants',
      payload: { name: 'Brain', slug: 'brain' },
    });
    const a = created.json().data;
    expect(a.enabled).toBe(false);
    expect(a.capabilities.requestExecution).toBe(false);
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/api/assistants/${a.id}`,
          payload: { expectedRevision: 1, enabled: true },
        })
      ).statusCode
    ).toBe(409);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/assistants',
          payload: { name: 'Oops', slug: 'oops', owner: 'admin' },
        })
      ).statusCode
    ).toBe(400);
    const home = join(root, 'codex');
    rollout(home, randomUUID(), root);
    sessions.set('pane-test', session(home));
    const bind = await app.inject({
      method: 'POST',
      url: `/api/assistants/${a.id}/binding`,
      payload: { sessionId: 'pane-test', expectedRevision: 1, expectedGeneration: 0 },
    });
    expect(bind.statusCode).toBe(200);
    expect(bind.json().data.binding.generation).toBe(1);
  });
});
