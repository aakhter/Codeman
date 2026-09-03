import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMockRouteContext } from '../mocks/index.js';
import { installRouteErrorHandler } from '../../src/web/route-error-handler.js';
import { registerCodexCommandProfileRoutes } from '../../src/web/routes/codex-command-profile-routes.js';
import { writeRemoteCases } from '../../src/remote-hosts.js';

describe('Codex command profile routes', () => {
  let app: FastifyInstance;
  let profiles: Record<string, Array<{ id: string; name: string; command: string }>>;
  let localCommandSelections: Record<string, Record<string, { kind: 'profile'; profileId: string }>>;
  let dataDir: string;
  let profileWrites: number;

  beforeEach(async () => {
    process.env.CODEMAN_MULTIUSER = '1';
    dataDir = await mkdtemp(join(tmpdir(), 'codex-profile-routes-'));
    process.env.CODEMAN_DATA_DIR = dataDir;
    profiles = {};
    localCommandSelections = {};
    profileWrites = 0;
    app = Fastify({ logger: false });
    app.addHook('onRequest', async (req) => {
      const username = req.headers['x-test-owner'];
      (req as unknown as { authUser: { username: string; role: 'user' } }).authUser = {
        username: typeof username === 'string' ? username : 'alice',
        role: 'user',
      };
    });
    const ctx = createMockRouteContext();
    ctx.store.getCodexCommandProfiles.mockImplementation((owner: string) => profiles[owner] ?? []);
    ctx.store.setCodexCommandProfiles.mockImplementation(
      (owner: string, next: Array<{ id: string; name: string; command: string }>) => {
        profiles[owner] = next;
        profileWrites++;
      }
    );
    ctx.store.getCaseCodexCommandSelections.mockImplementation((owner: string) => localCommandSelections[owner] ?? {});
    registerCodexCommandProfileRoutes(app, ctx as never);
    installRouteErrorHandler(app);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    delete process.env.CODEMAN_MULTIUSER;
    delete process.env.CODEMAN_DATA_DIR;
    await rm(dataDir, { recursive: true, force: true });
  });

  const request = (owner: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) =>
    app.inject({ method, url, headers: { 'x-test-owner': owner }, payload });

  it('keeps Alice and Bob profile libraries private and sorts names case-insensitively', async () => {
    const alice = await request('alice', 'POST', '/api/codex-command-profiles', {
      name: 'zebra',
      command: ' codex z ',
    });
    expect(alice.statusCode).toBe(200);
    await request('alice', 'POST', '/api/codex-command-profiles', { name: 'Alpha', command: 'codex a' });
    await request('bob', 'POST', '/api/codex-command-profiles', { name: 'Secret', command: 'codex b' });

    const listed = await request('alice', 'GET', '/api/codex-command-profiles');
    expect(JSON.parse(listed.body).data.profiles).toEqual([
      expect.objectContaining({ name: 'Alpha', command: 'codex a', usage: [] }),
      expect.objectContaining({ name: 'zebra', command: 'codex z', usage: [] }),
    ]);
    expect(JSON.parse((await request('bob', 'GET', '/api/codex-command-profiles')).body).data.profiles).toEqual([
      expect.objectContaining({ name: 'Secret', usage: [] }),
    ]);
  });

  it('rejects duplicate case-insensitive names and invalid profile input', async () => {
    expect(
      (await request('alice', 'POST', '/api/codex-command-profiles', { name: 'Personal', command: 'codex' })).statusCode
    ).toBe(200);
    expect(
      (await request('alice', 'POST', '/api/codex-command-profiles', { name: ' personal ', command: 'other' }))
        .statusCode
    ).toBe(409);
    expect(
      (await request('alice', 'POST', '/api/codex-command-profiles', { name: '', command: 'codex' })).statusCode
    ).toBe(400);
    expect(
      (await request('alice', 'POST', '/api/codex-command-profiles', { name: 'x'.repeat(61), command: 'codex' }))
        .statusCode
    ).toBe(400);
    expect(
      (await request('alice', 'POST', '/api/codex-command-profiles', { name: 'ok', command: 'x'.repeat(301) }))
        .statusCode
    ).toBe(400);
  });

  it('requires confirmation to update a referenced command but not an unreferenced field', async () => {
    profiles.alice = [{ id: 'profile-1', name: 'Personal', command: 'codex old' }];
    await writeRemoteCases(dataDir, [
      {
        name: 'Case A',
        type: 'remote',
        owner: 'alice',
        hostId: 'a',
        remotePath: '/a',
        codexCommandProfileId: 'profile-1',
      },
    ]);

    const blocked = await request('alice', 'PUT', '/api/codex-command-profiles/profile-1', { command: 'codex new' });
    expect(blocked.statusCode).toBe(400);
    expect(JSON.parse(blocked.body)).toMatchObject({
      errorCode: 'OPERATION_FAILED',
      requiresConfirmation: true,
      usage: ['Case A'],
    });

    const confirmed = await request('alice', 'PUT', '/api/codex-command-profiles/profile-1', {
      command: 'codex new',
      confirmReferencedUpdate: true,
    });
    expect(confirmed.statusCode).toBe(200);
    expect(profiles.alice[0].command).toBe('codex new');
  });

  it('rejects a normalized update that makes no effective change without writing', async () => {
    profiles.alice = [{ id: 'profile-1', name: 'Personal', command: 'codex old' }];

    const unchanged = await request('alice', 'PUT', '/api/codex-command-profiles/profile-1', {
      name: ' Personal ',
      command: ' codex old ',
    });

    expect(unchanged.statusCode).toBe(400);
    expect(JSON.parse(unchanged.body)).toMatchObject({ errorCode: 'OPERATION_FAILED' });
    expect(profileWrites).toBe(0);
  });

  it('reports case-sensitive usage for referenced delete and permits unused deletion', async () => {
    profiles.alice = [
      { id: 'used', name: 'Used', command: 'codex used' },
      { id: 'unused', name: 'Unused', command: 'codex unused' },
      { id: 'local-only', name: 'Local', command: 'codex local' },
    ];
    await writeRemoteCases(dataDir, [
      {
        name: 'Case upper',
        type: 'remote',
        owner: 'alice',
        hostId: 'a',
        remotePath: '/a',
        codexCommandProfileId: 'used',
      },
      {
        name: 'case lower',
        type: 'remote',
        owner: 'alice',
        hostId: 'b',
        remotePath: '/b',
        codexCommandProfileId: 'used',
      },
    ]);
    const blocked = await request('alice', 'DELETE', '/api/codex-command-profiles/used');
    expect(blocked.statusCode).toBe(409);
    expect(JSON.parse(blocked.body)).toMatchObject({
      error: 'Profile is still used by cases',
      usage: ['case lower', 'Case upper'],
    });
    expect((await request('alice', 'DELETE', '/api/codex-command-profiles/unused')).statusCode).toBe(200);
  });

  it('blocks deletion when a local case references the profile', async () => {
    profiles.alice = [{ id: 'local-profile', name: 'Local', command: 'codex local' }];
    localCommandSelections.alice = { 'local-case': { kind: 'profile', profileId: 'local-profile' } };

    const blocked = await request('alice', 'DELETE', '/api/codex-command-profiles/local-profile');
    expect(blocked.statusCode).toBe(409);
    expect(JSON.parse(blocked.body)).toMatchObject({
      error: 'Profile is still used by cases',
      usage: ['local-case'],
    });
  });
});
