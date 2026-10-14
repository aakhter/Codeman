/**
 * @fileoverview Tests for session route handlers.
 *
 * Uses app.inject() (Fastify's built-in test helper) — no real HTTP ports needed.
 * Port: N/A (app.inject doesn't open ports)
 *
 * These tests assert the UNIFORM response envelope (stable HTTP contract):
 *   success -> 2xx, { success: true, data: <payload> }
 *   error   -> 4xx/5xx, { success: false, error, errorCode }
 * The production server applies this via a preSerialization hook (server.ts).
 * The shared route harness doesn't install it, so we build a local harness here
 * that mirrors production: the same preSerialization envelope hook + the shared
 * route error handler, so assertions match the real wire format.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyMultipart from '@fastify/multipart';
import { registryFilePath, reloadCliRegistry } from '../../src/config/cli-registry/registry.js';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import fs, { mkdtemp, rm, mkdir, writeFile, readFile, readdir, symlink } from 'node:fs/promises';
import { createMockRouteContext, type MockRouteContext } from '../mocks/index.js';
import { installRouteErrorHandler } from '../../src/web/route-error-handler.js';
import { ApiErrorCode, httpStatusForErrorCode } from '../../src/types.js';
import { Session } from '../../src/session.js';
import { writeHooksConfig } from '../../src/hooks-config.js';
import type { TabLayout } from '../../src/tab-layout.js';
import { dataPath } from '../../src/config/instance.js';
import { CASES_DIR, resolveCasesDir } from '../../src/web/route-helpers.js';
import { createUser, invalidateUsersCache } from '../../src/user-store.js';

// Mock execFile so the send-key route's `tmux` invocation is observable (not run for real).
const { execFile, spawn } = vi.hoisted(() => ({ execFile: vi.fn(), spawn: vi.fn() }));
const remoteImageWrite = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../../src/remote-file-transfer.js', async (orig) => ({
  ...(await orig<typeof import('../../src/remote-file-transfer.js')>()),
  writeRemoteFileBytes: remoteImageWrite,
}));
const heicConvert = vi.hoisted(() => vi.fn(async () => Buffer.from('ffd8ffe000104a4649460001', 'hex')));
const remoteStore = vi.hoisted(() => ({
  hosts: [] as Array<{
    id: string;
    label: string;
    host: string;
    username: string;
    commands?: Record<string, string>;
  }>,
  cases: [] as Array<{
    name: string;
    type: 'remote';
    hostId: string;
    remotePath: string;
    commands?: Record<string, string>;
    codexCommandProfileId?: string;
    owner?: string;
  }>,
  tmuxCheck: { ok: true, tmuxPath: '/usr/bin/tmux' } as { ok: boolean; tmuxPath?: string; error?: string },
}));
const dockerStore = vi.hoisted(() => ({
  hosts: [] as Array<{ id: string; label: string; engine: 'docker'; image: string }>,
  cases: [] as Array<{
    name: string;
    type: 'docker';
    hostId: string;
    hostWorkspacePath: string;
    containerWorkdir?: string;
  }>,
}));
const cliAvailability = vi.hoisted(() => ({
  opencode: true,
  codex: true,
  gemini: true,
  antigravity: true,
  pi: true,
}));
const cliDiagnostics = vi.hoisted(() => ({
  opencode: 'OpenCode resolver diagnostic',
  codex: 'Codex resolver diagnostic',
  gemini: 'Gemini resolver diagnostic',
  antigravity: 'Antigravity resolver diagnostic',
  pi: 'Pi resolver diagnostic',
}));
vi.mock('node:child_process', async (orig) => {
  const actual = await orig<typeof import('node:child_process')>();
  return { ...actual, execFile, spawn };
});
vi.mock('heic-convert', () => ({ default: heicConvert }));
vi.mock('../../src/remote-hosts.js', async (orig) => {
  const actual = await orig<typeof import('../../src/remote-hosts.js')>();
  return {
    ...actual,
    readRemoteHosts: vi.fn(async () => remoteStore.hosts),
    readRemoteCases: vi.fn(async () => remoteStore.cases),
    checkRemoteTmuxAvailable: vi.fn(async () => remoteStore.tmuxCheck),
  };
});
vi.mock('../../src/docker-hosts.js', async (orig) => {
  const actual = await orig<typeof import('../../src/docker-hosts.js')>();
  return {
    ...actual,
    readDockerHosts: vi.fn(async () => dockerStore.hosts),
    readDockerCases: vi.fn(async () => dockerStore.cases),
  };
});
vi.mock('../../src/web/heic-jpeg-converter.js', () => ({ convertHeicToJpeg: heicConvert }));
vi.mock('../../src/utils/opencode-cli-resolver.js', async (orig) => ({
  ...(await orig<typeof import('../../src/utils/opencode-cli-resolver.js')>()),
  isOpenCodeAvailable: vi.fn(() => cliAvailability.opencode),
  getOpenCodeNotFoundMessage: vi.fn(() => 'OpenCode resolver diagnostic'),
}));
vi.mock('../../src/utils/codex-cli-resolver.js', async (orig) => ({
  ...(await orig<typeof import('../../src/utils/codex-cli-resolver.js')>()),
  isCodexAvailable: vi.fn(() => cliAvailability.codex),
  getCodexNotFoundMessage: vi.fn(() => 'Codex resolver diagnostic'),
}));
vi.mock('../../src/utils/gemini-cli-resolver.js', async (orig) => ({
  ...(await orig<typeof import('../../src/utils/gemini-cli-resolver.js')>()),
  isGeminiAvailable: vi.fn(() => cliAvailability.gemini),
  getGeminiNotFoundMessage: vi.fn(() => 'Gemini resolver diagnostic'),
}));
vi.mock('../../src/utils/antigravity-cli-resolver.js', async (orig) => ({
  ...(await orig<typeof import('../../src/utils/antigravity-cli-resolver.js')>()),
  isAntigravityAvailable: vi.fn(() => cliAvailability.antigravity),
  getAntigravityNotFoundMessage: vi.fn(() => 'Antigravity resolver diagnostic'),
}));
vi.mock('../../src/utils/pi-cli-resolver.js', async (orig) => ({
  ...(await orig<typeof import('../../src/utils/pi-cli-resolver.js')>()),
  isPiAvailable: vi.fn(() => cliAvailability.pi),
  getPiNotFoundMessage: vi.fn(() => 'Pi resolver diagnostic'),
}));

// The CLI registry moved the not-found seam: the create/quick-start pre-flights now go
// through resolveCliLaunchError -> resolveCliBinDir / missingCliMessage instead of each
// CLI's own isXAvailable/getXNotFoundMessage. Mocking HERE is what keeps the pre-flight
// tests meaningful and, importantly, environment-independent — reading the real resolver
// would make them pass or fail depending on which CLIs happen to be installed on the box.
vi.mock('../../src/utils/cli-resolver.js', async (orig) => {
  const actual = await orig<typeof import('../../src/utils/cli-resolver.js')>();
  return {
    ...actual,
    resolveCliBinDir: vi.fn((id: string) =>
      id in cliAvailability && !cliAvailability[id as keyof typeof cliAvailability] ? null : actual.resolveCliBinDir(id)
    ),
    missingCliMessage: vi.fn((id: string) =>
      id in cliDiagnostics ? cliDiagnostics[id as keyof typeof cliDiagnostics] : actual.missingCliMessage(id)
    ),
  };
});

import { registerSessionRoutes } from '../../src/web/routes/session-routes.js';
import { checkRemoteTmuxAvailable as checkRemoteTmuxProbe } from '../../src/remote-hosts.js';
import { RemoteWakeRegistry, REMOTE_WAKE_REQUEST_READY_TIMEOUT_MS } from '../../src/remote-wake.js';
import { resolveTerminalHistoryConfig } from '../../src/config/terminal-history.js';
import { isOpenCodeAvailable } from '../../src/utils/opencode-cli-resolver.js';
import { isCodexAvailable } from '../../src/utils/codex-cli-resolver.js';
import { isGeminiAvailable } from '../../src/utils/gemini-cli-resolver.js';
import { isAntigravityAvailable } from '../../src/utils/antigravity-cli-resolver.js';
import { isPiAvailable } from '../../src/utils/pi-cli-resolver.js';

interface LocalHarness {
  app: FastifyInstance;
  ctx: MockRouteContext;
}

// Wake-on-LAN seam: the production registry opens a real TCP connection to the host
// and can run a real wake command, so every route registered here gets a fake one
// (the same seam `test/routes/session-remote-wake.test.ts` uses). Default: the host
// answers, so nothing ever wakes.
const wakeProbe = vi.fn(async () => true);
const wakeCommandRun = vi.fn(async () => true);
const wakeWaitUntilReady = vi.fn(async () => true);
let wakeRegistry: RemoteWakeRegistry;

/**
 * Build a Fastify instance that mirrors production's uniform-envelope behavior
 * (server.ts preSerialization hook) so the test wire format matches the contract:
 * bare payloads become { success: true, data }, and { success:false } error
 * envelopes get the conventional HTTP status from their errorCode.
 */
async function createEnvelopeHarness(
  registerFn: (app: FastifyInstance, ctx: MockRouteContext) => void,
  authUser?: { username: string; role: 'admin' | 'user' }
): Promise<LocalHarness> {
  const app = Fastify({ logger: false });
  await app.register(fastifyCookie);
  await app.register(fastifyMultipart, {
    limits: {
      fileSize: 10 * 1024 * 1024,
      files: 1,
      fields: 4,
      parts: 5,
    },
  });

  if (authUser) {
    app.addHook('onRequest', (req, _reply, done) => {
      req.authUser = authUser;
      done();
    });
  }

  const ctx = createMockRouteContext();
  registerFn(app, ctx);

  // Mirror production uniform response envelope (server.ts).
  app.addHook('preSerialization', (req, reply, payload: unknown, done) => {
    if (!req.url.startsWith('/api')) return done(null, payload);
    if (payload === null || typeof payload !== 'object') return done(null, payload);
    if (Buffer.isBuffer(payload) || typeof (payload as { pipe?: unknown }).pipe === 'function') {
      return done(null, payload);
    }
    const p = payload as { success?: unknown; errorCode?: unknown };
    if (p.success === false) {
      if (reply.statusCode === 200 && typeof p.errorCode === 'string') {
        reply.code(httpStatusForErrorCode(p.errorCode as ApiErrorCode));
      }
      return done(null, payload);
    }
    if (p.success === true) return done(null, payload);
    return done(null, { success: true, data: payload });
  });

  installRouteErrorHandler(app);
  await app.ready();

  return { app, ctx };
}

describe('session-routes', () => {
  let harness: LocalHarness;

  const useRegularUserHarness = async (username: string, canBypassPermissions = false) => {
    const previousMultiuser = process.env.CODEMAN_MULTIUSER;
    const previousUserSpacesDir = process.env.CODEMAN_USER_SPACES_DIR;
    const userSpacesDir = await mkdtemp(join(tmpdir(), 'codeman-user-spaces-'));
    process.env.CODEMAN_MULTIUSER = '1';
    process.env.CODEMAN_USER_SPACES_DIR = userSpacesDir;
    await createUser({
      username,
      role: 'user',
      password: 'regularpass123',
      canBypassPermissions,
    });
    invalidateUsersCache();
    await harness.app.close();
    harness = await createEnvelopeHarness(registerSessionRoutes, { username, role: 'user' });
    return async () => {
      if (previousMultiuser === undefined) delete process.env.CODEMAN_MULTIUSER;
      else process.env.CODEMAN_MULTIUSER = previousMultiuser;
      if (previousUserSpacesDir === undefined) delete process.env.CODEMAN_USER_SPACES_DIR;
      else process.env.CODEMAN_USER_SPACES_DIR = previousUserSpacesDir;
      invalidateUsersCache();
      await rm(userSpacesDir, { recursive: true, force: true });
    };
  };

  beforeEach(async () => {
    wakeProbe.mockReset().mockResolvedValue(true);
    wakeCommandRun.mockReset().mockResolvedValue(true);
    wakeWaitUntilReady.mockReset().mockResolvedValue(true);
    wakeRegistry = new RemoteWakeRegistry({
      probe: wakeProbe,
      wake: wakeCommandRun,
      waitUntilReady: wakeWaitUntilReady,
      delay: async () => {},
      log: () => {},
    });
    harness = await createEnvelopeHarness((app, ctx) => registerSessionRoutes(app, ctx, { remoteWake: wakeRegistry }));
    // Reset remote store so tests start with empty hosts/cases and a passing tmux probe
    remoteStore.hosts = [];
    remoteStore.cases = [];
    dockerStore.hosts = [];
    dockerStore.cases = [];
    remoteStore.tmuxCheck = { ok: true, tmuxPath: '/usr/bin/tmux' };
    Object.assign(cliAvailability, {
      opencode: true,
      codex: true,
      gemini: true,
      antigravity: true,
      pi: true,
    });
  });

  afterEach(async () => {
    await harness.app.close();
  });

  const authoritativeTabLayout: TabLayout = {
    version: 7,
    groups: [{ id: 'work', name: 'Work', refs: [{ kind: 'session', id: 'created-session' }] }],
    ungrouped: [],
    updatedAt: '2026-08-18T12:00:00.000Z',
  };
  const authoritativeTabPlacements = [
    { kind: 'session' as const, id: 'created-session', state: 'manual' as const, parentId: 'parent', canFollow: true },
  ];

  describe('session creation tab placement', () => {
    it('returns the authoritative layout for a targeted session creation', async () => {
      remoteStore.hosts = [{ id: 'gpu-box', label: 'GPU Box', host: '10.0.0.42', username: 'ubuntu', commands: {} }];
      remoteStore.cases = [{ name: 'nzbdav', type: 'remote', hostId: 'gpu-box', remotePath: '/srv/nzbdav' }];
      harness.ctx.addSession.mockResolvedValueOnce({
        layout: authoritativeTabLayout,
        placements: authoritativeTabPlacements,
      });

      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: { caseName: 'nzbdav', mode: 'shell', tabGroupId: 'work' },
      });

      expect(response.statusCode).toBe(200);
      expect(harness.ctx.addSession).toHaveBeenCalledWith(expect.any(Session), {
        caseName: 'nzbdav',
        tabGroupId: 'work',
      });
      expect(JSON.parse(response.body).data.tabLayout).toEqual(authoritativeTabLayout);
      expect(JSON.parse(response.body).data.tabPlacements).toEqual(authoritativeTabPlacements);
    });

    it('returns the authoritative layout when the case default placed a standard session', async () => {
      remoteStore.hosts = [{ id: 'gpu-box', label: 'GPU Box', host: '10.0.0.42', username: 'ubuntu', commands: {} }];
      remoteStore.cases = [{ name: 'nzbdav', type: 'remote', hostId: 'gpu-box', remotePath: '/srv/nzbdav' }];
      harness.ctx.addSession.mockResolvedValueOnce({
        layout: authoritativeTabLayout,
        placements: authoritativeTabPlacements,
        placementSource: 'case-default',
      });

      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: { caseName: 'nzbdav', mode: 'shell' },
      });

      expect(response.statusCode).toBe(200);
      expect(harness.ctx.addSession).toHaveBeenCalledWith(expect.any(Session), { caseName: 'nzbdav' });
      expect(JSON.parse(response.body).data.tabLayout).toEqual(authoritativeTabLayout);
      expect(JSON.parse(response.body).data.tabPlacements).toEqual(authoritativeTabPlacements);
    });

    it.each([
      ['claude', false],
      ['shell', true],
    ] as const)(
      'preserves the regular-user local %s UI case path and applies the case default',
      async (mode, canBypassPermissions) => {
        const username = mode === 'shell' ? 'uishell' : 'uiclaude';
        const cleanup = await useRegularUserHarness(username, canBypassPermissions);
        const caseName = `ui-${mode}-case`;
        const workingDir = join(resolveCasesDir({ username, role: 'user' }), caseName);
        await mkdir(workingDir, { recursive: true });
        harness.ctx.addSession.mockResolvedValueOnce({
          layout: authoritativeTabLayout,
          placements: authoritativeTabPlacements,
          placementSource: 'case-default',
        });
        try {
          const response = await harness.app.inject({
            method: 'POST',
            url: '/api/sessions',
            payload: {
              caseName,
              workingDir,
              mode,
              name: `w1-${caseName}`,
            },
          });

          expect(response.statusCode).toBe(200);
          const created = harness.ctx.addSession.mock.calls.at(-1)?.[0] as Session;
          expect(created.workingDir).toBe(workingDir);
          expect(harness.ctx.addSession).toHaveBeenCalledWith(expect.any(Session), { caseName });
          expect(JSON.parse(response.body).data.tabLayout).toEqual(authoritativeTabLayout);
          expect(JSON.parse(response.body).data.tabPlacements).toEqual(authoritativeTabPlacements);
        } finally {
          await cleanup();
        }
      }
    );

    it('resolves a regular-user managed caseName-only launch inside the user case root', async () => {
      const username = 'nameonlyuser';
      const cleanup = await useRegularUserHarness(username);
      const caseName = 'name-only-case';
      const workingDir = join(resolveCasesDir({ username, role: 'user' }), caseName);
      await mkdir(workingDir, { recursive: true });
      harness.ctx.addSession.mockResolvedValueOnce({
        layout: authoritativeTabLayout,
        placements: authoritativeTabPlacements,
        placementSource: 'case-default',
      });
      try {
        const response = await harness.app.inject({
          method: 'POST',
          url: '/api/sessions',
          payload: { caseName, mode: 'claude', name: `w1-${caseName}` },
        });

        expect(response.statusCode).toBe(200);
        const created = harness.ctx.addSession.mock.calls.at(-1)?.[0] as Session;
        expect(created.workingDir).toBe(workingDir);
        expect(harness.ctx.addSession).toHaveBeenCalledWith(expect.any(Session), { caseName });
        expect(JSON.parse(response.body).data.tabLayout).toEqual(authoritativeTabLayout);
        expect(JSON.parse(response.body).data.tabPlacements).toEqual(authoritativeTabPlacements);
      } finally {
        await cleanup();
      }
    });

    it('does not let another owner remote case shadow a regular-user local UI launch', async () => {
      const username = 'alicecollision';
      const cleanup = await useRegularUserHarness(username);
      const caseName = 'shared-name';
      const workingDir = join(resolveCasesDir({ username, role: 'user' }), caseName);
      await mkdir(workingDir, { recursive: true });
      remoteStore.hosts = [{ id: 'bob-host', label: 'Bob host', host: '10.0.0.52', username: 'bob' }];
      remoteStore.cases = [
        {
          name: caseName,
          type: 'remote',
          hostId: 'bob-host',
          remotePath: '/srv/bob/shared-name',
          owner: 'bob',
        },
      ];
      harness.ctx.addSession.mockResolvedValueOnce({
        layout: authoritativeTabLayout,
        placements: authoritativeTabPlacements,
        placementSource: 'case-default',
      });
      try {
        const response = await harness.app.inject({
          method: 'POST',
          url: '/api/sessions',
          payload: { caseName, workingDir, mode: 'claude', name: `w1-${caseName}` },
        });

        expect(response.statusCode).toBe(200);
        expect(checkRemoteTmuxProbe).not.toHaveBeenCalled();
        const created = harness.ctx.addSession.mock.calls.at(-1)?.[0] as Session;
        expect(created.workingDir).toBe(workingDir);
        expect(harness.ctx.addSession).toHaveBeenCalledWith(expect.any(Session), { caseName });
        expect(JSON.parse(response.body).data.tabLayout).toEqual(authoritativeTabLayout);
        expect(JSON.parse(response.body).data.tabPlacements).toEqual(authoritativeTabPlacements);
      } finally {
        await cleanup();
      }
    });

    it('keeps an ownerless legacy remote case accessible in single-user mode', async () => {
      remoteStore.hosts = [{ id: 'legacy-host', label: 'Legacy host', host: '10.0.0.53', username: 'legacy' }];
      remoteStore.cases = [
        {
          name: 'legacy-remote',
          type: 'remote',
          hostId: 'legacy-host',
          remotePath: '/srv/legacy/work',
        },
      ];

      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: { caseName: 'legacy-remote', mode: 'claude' },
      });

      expect(response.statusCode).toBe(200);
      expect(checkRemoteTmuxProbe).toHaveBeenCalledOnce();
      const created = harness.ctx.addSession.mock.calls.at(-1)?.[0] as Session;
      expect(created.workingDir).toBe('/srv/legacy/work');
      expect(harness.ctx.addSession).toHaveBeenCalledWith(expect.any(Session), { caseName: 'legacy-remote' });
    });

    it.each([
      {
        selection: 'profile',
        remoteCase: { codexCommandProfileId: 'personal-codex' },
        profiles: [{ id: 'personal-codex', name: 'Personal', command: 'exec codex --profile personal' }],
        expected: 'exec codex --profile personal',
      },
      {
        selection: 'custom',
        remoteCase: { commands: { codex: 'exec codex --model o3' } },
        profiles: [],
        expected: 'exec codex --model o3',
      },
      { selection: 'default', remoteCase: {}, profiles: [], expected: 'exec codex --host-default' },
    ])(
      'uses the $selection Codex command selection before creating a remote session',
      async ({ remoteCase, profiles, expected }) => {
        remoteStore.hosts = [
          {
            id: 'gpu-box',
            label: 'GPU Box',
            host: '10.0.0.42',
            username: 'ubuntu',
            commands: { codex: 'exec codex --host-default' },
          },
        ];
        remoteStore.cases = [
          { name: 'codex-work', type: 'remote', hostId: 'gpu-box', remotePath: '/srv/codex', ...remoteCase },
        ];
        harness.ctx.store.getCodexCommandProfiles.mockReturnValue(profiles);
        const response = await harness.app.inject({
          method: 'POST',
          url: '/api/sessions',
          payload: { caseName: 'codex-work', mode: 'codex' },
        });
        expect(response.statusCode).toBe(200);
        const created = harness.ctx.addSession.mock.calls.at(-1)?.[0] as Session;
        expect(created.remote?.commands?.codex).toBe(expected);
      }
    );

    it('fails a missing selected profile before the remote tmux probe or Session construction', async () => {
      remoteStore.hosts = [{ id: 'gpu-box', label: 'GPU Box', host: '10.0.0.42', username: 'ubuntu' }];
      remoteStore.cases = [
        {
          name: 'missing-profile',
          type: 'remote',
          hostId: 'gpu-box',
          remotePath: '/srv/codex',
          codexCommandProfileId: 'deleted-profile',
        },
      ];
      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: { caseName: 'missing-profile', mode: 'codex' },
      });
      expect(response.statusCode).toBe(httpStatusForErrorCode(ApiErrorCode.OPERATION_FAILED));
      expect(JSON.parse(response.body)).toMatchObject({
        errorCode: ApiErrorCode.OPERATION_FAILED,
        error: 'Saved Codex command profile is unavailable',
      });
      expect(checkRemoteTmuxProbe).not.toHaveBeenCalled();
      expect(harness.ctx.addSession).not.toHaveBeenCalled();
    });

    it('fails Quick Start for a missing selected profile before the remote tmux probe or Session construction', async () => {
      remoteStore.hosts = [{ id: 'gpu-box', label: 'GPU Box', host: '10.0.0.42', username: 'ubuntu' }];
      remoteStore.cases = [
        {
          name: 'quick-missing-profile',
          type: 'remote',
          hostId: 'gpu-box',
          remotePath: '/srv/codex',
          codexCommandProfileId: 'deleted-profile',
        },
      ];

      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/quick-start',
        payload: { caseName: 'quick-missing-profile', mode: 'codex' },
      });

      expect(response.statusCode).toBe(httpStatusForErrorCode(ApiErrorCode.OPERATION_FAILED));
      expect(JSON.parse(response.body)).toMatchObject({
        errorCode: ApiErrorCode.OPERATION_FAILED,
        error: 'Saved Codex command profile is unavailable',
      });
      expect(checkRemoteTmuxProbe).not.toHaveBeenCalled();
      expect(harness.ctx.addSession).not.toHaveBeenCalled();
    });

    it('uses a saved local Codex command as the complete launch command', async () => {
      const caseName = 'local-codex-command';
      const workingDir = join(CASES_DIR, caseName);
      await mkdir(workingDir, { recursive: true });
      harness.ctx.store.getCaseCodexCommandSelection.mockReturnValue({
        kind: 'custom',
        command: 'codex --local-exact',
      });
      cliAvailability.codex = false;

      try {
        const response = await harness.app.inject({
          method: 'POST',
          url: '/api/sessions',
          payload: { caseName, mode: 'codex' },
        });

        expect(response.statusCode).toBe(200);
        const created = harness.ctx.addSession.mock.calls.at(-1)?.[0] as Session;
        expect(created.codexConfig?.baseCommand).toBe('codex --local-exact');
        expect(harness.ctx.addSession).toHaveBeenCalledWith(expect.any(Session), { caseName });
      } finally {
        await rm(workingDir, { recursive: true, force: true });
      }
    });

    it.each([
      {
        selection: { kind: 'profile' as const, profileId: 'cisco' },
        profiles: [{ id: 'cisco', name: 'Cisco', command: 'exec codx cisco' }],
      },
      {
        selection: { kind: 'custom' as const, command: 'exec codx personal' },
        profiles: [],
      },
    ])('uses the selected local Codex command in Quick Start ($selection.kind)', async ({ selection, profiles }) => {
      const caseName = 'quick-local-codex-command';
      const workingDir = join(CASES_DIR, caseName);
      await mkdir(workingDir, { recursive: true });
      harness.ctx.store.getCaseCodexCommandSelection.mockReturnValue(selection);
      harness.ctx.store.getCodexCommandProfiles.mockReturnValue(profiles);
      cliAvailability.codex = false;
      const startInteractive = vi.spyOn(Session.prototype, 'startInteractive').mockResolvedValue(undefined);

      try {
        const response = await harness.app.inject({
          method: 'POST',
          url: '/api/quick-start',
          payload: { caseName, mode: 'codex' },
        });

        expect(response.statusCode).toBe(200);
        const sessionId = JSON.parse(response.body).data.sessionId as string;
        expect(harness.ctx.sessions.get(sessionId)?.codexConfig?.baseCommand).toBe(
          selection.kind === 'profile' ? profiles[0].command : selection.command
        );
        expect(harness.ctx.store.getCaseCodexCommandSelection).toHaveBeenCalledWith('@single', caseName);
      } finally {
        startInteractive.mockRestore();
        await rm(workingDir, { recursive: true, force: true });
      }
    });

    it('fails Quick Start before creating a local session when its selected profile is missing', async () => {
      const caseName = 'quick-local-codex-missing';
      harness.ctx.store.getCaseCodexCommandSelection.mockReturnValue({ kind: 'profile', profileId: 'deleted' });
      harness.ctx.store.getCodexCommandProfiles.mockReturnValue([]);

      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/quick-start',
        payload: { caseName, mode: 'codex' },
      });

      expect(response.statusCode).toBe(httpStatusForErrorCode(ApiErrorCode.OPERATION_FAILED));
      expect(JSON.parse(response.body)).toMatchObject({
        errorCode: ApiErrorCode.OPERATION_FAILED,
        error: 'Saved Codex command profile is unavailable',
      });
      expect(harness.ctx.addSession).not.toHaveBeenCalled();
    });

    it('denies Quick Start for a non-granted local Codex command', async () => {
      const username = 'quicklocalcodexuser';
      const cleanup = await useRegularUserHarness(username, false);
      const caseName = 'quick-local-codex-denied';
      harness.ctx.store.getCaseCodexCommandSelection.mockReturnValue({
        kind: 'custom',
        command: 'exec codx cisco',
      });

      try {
        const response = await harness.app.inject({
          method: 'POST',
          url: '/api/quick-start',
          payload: { caseName, mode: 'codex' },
        });

        expect(response.statusCode).toBe(httpStatusForErrorCode(ApiErrorCode.FORBIDDEN));
        expect(harness.ctx.addSession).not.toHaveBeenCalled();
      } finally {
        await cleanup();
      }
    });

    it('fails a missing local Codex profile before Session construction', async () => {
      const caseName = 'local-codex-missing';
      const workingDir = join(CASES_DIR, caseName);
      await mkdir(workingDir, { recursive: true });
      harness.ctx.store.getCaseCodexCommandSelection.mockReturnValue({
        kind: 'profile',
        profileId: 'deleted-profile',
      });
      harness.ctx.store.getCodexCommandProfiles.mockReturnValue([]);

      try {
        const response = await harness.app.inject({
          method: 'POST',
          url: '/api/sessions',
          payload: { caseName, mode: 'codex' },
        });

        expect(response.statusCode).toBe(httpStatusForErrorCode(ApiErrorCode.OPERATION_FAILED));
        expect(JSON.parse(response.body)).toMatchObject({
          errorCode: ApiErrorCode.OPERATION_FAILED,
          error: 'Saved Codex command profile is unavailable',
        });
        expect(harness.ctx.addSession).not.toHaveBeenCalled();
      } finally {
        await rm(workingDir, { recursive: true, force: true });
      }
    });

    it('denies a non-granted multi-user local Codex command at launch', async () => {
      const username = 'localcodexuser';
      const cleanup = await useRegularUserHarness(username, false);
      const caseName = 'local-codex-denied';
      const workingDir = join(resolveCasesDir({ username, role: 'user' }), caseName);
      await mkdir(workingDir, { recursive: true });
      harness.ctx.store.getCaseCodexCommandSelection.mockReturnValue({
        kind: 'custom',
        command: 'codex --local-exact',
      });

      try {
        const response = await harness.app.inject({
          method: 'POST',
          url: '/api/sessions',
          payload: { caseName, mode: 'codex' },
        });

        expect(response.statusCode).toBe(httpStatusForErrorCode(ApiErrorCode.FORBIDDEN));
        expect(harness.ctx.addSession).not.toHaveBeenCalled();
      } finally {
        await rm(workingDir, { recursive: true, force: true });
        await cleanup();
      }
    });

    it('launches a Bob-owned selected profile when an admin creates a remote session', async () => {
      vi.stubEnv('CODEMAN_MULTIUSER', '1');
      await harness.app.close();
      harness = await createEnvelopeHarness(registerSessionRoutes, { username: 'root', role: 'admin' });
      remoteStore.hosts = [{ id: 'gpu-box', label: 'GPU Box', host: '10.0.0.42', username: 'ubuntu' }];
      remoteStore.cases = [
        {
          name: 'bob-profile-session',
          type: 'remote',
          owner: 'bob',
          hostId: 'gpu-box',
          remotePath: '/srv/bob',
          codexCommandProfileId: 'bob-profile',
        },
      ];
      harness.ctx.store.getCodexCommandProfiles.mockImplementation((owner: string) =>
        owner === 'bob' ? [{ id: 'bob-profile', name: 'Bob', command: 'exec codex --profile bob' }] : []
      );

      try {
        const response = await harness.app.inject({
          method: 'POST',
          url: '/api/sessions',
          payload: { caseName: 'bob-profile-session', mode: 'codex' },
        });

        expect(response.statusCode).toBe(200);
        const created = harness.ctx.addSession.mock.calls.at(-1)?.[0] as Session;
        expect(created.remote?.commands?.codex).toBe('exec codex --profile bob');
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it('launches a Bob-owned selected profile when an admin uses Quick Start', async () => {
      vi.stubEnv('CODEMAN_MULTIUSER', '1');
      await harness.app.close();
      harness = await createEnvelopeHarness(registerSessionRoutes, { username: 'root', role: 'admin' });
      remoteStore.hosts = [{ id: 'gpu-box', label: 'GPU Box', host: '10.0.0.42', username: 'ubuntu' }];
      remoteStore.cases = [
        {
          name: 'bob-profile-quick',
          type: 'remote',
          owner: 'bob',
          hostId: 'gpu-box',
          remotePath: '/srv/bob',
          codexCommandProfileId: 'bob-profile',
        },
      ];
      harness.ctx.store.getCodexCommandProfiles.mockImplementation((owner: string) =>
        owner === 'bob' ? [{ id: 'bob-profile', name: 'Bob', command: 'exec codex --profile bob' }] : []
      );
      const startInteractive = vi.spyOn(Session.prototype, 'startInteractive').mockResolvedValue(undefined);

      try {
        const response = await harness.app.inject({
          method: 'POST',
          url: '/api/quick-start',
          payload: { caseName: 'bob-profile-quick', mode: 'codex' },
        });

        expect(response.statusCode).toBe(200);
        const created = [...harness.ctx.sessions.values()].find((session) => session.remote?.remotePath === '/srv/bob');
        expect(created?.remote?.commands?.codex).toBe('exec codex --profile bob');
      } finally {
        startInteractive.mockRestore();
        vi.unstubAllEnvs();
      }
    });

    it('still resolves a regular users own remote case', async () => {
      const username = 'aliceownedremote';
      const cleanup = await useRegularUserHarness(username);
      const remotePath = join(resolveCasesDir({ username, role: 'user' }), 'remote-compatible-path');
      remoteStore.hosts = [{ id: 'alice-host', label: 'Alice host', host: '10.0.0.54', username: 'alice' }];
      remoteStore.cases = [
        {
          name: 'alice-remote',
          type: 'remote',
          hostId: 'alice-host',
          remotePath,
          owner: username,
        },
      ];
      try {
        const response = await harness.app.inject({
          method: 'POST',
          url: '/api/sessions',
          payload: { caseName: 'alice-remote', mode: 'claude' },
        });

        expect(response.statusCode).toBe(200);
        expect(checkRemoteTmuxProbe).toHaveBeenCalledOnce();
        const created = harness.ctx.addSession.mock.calls.at(-1)?.[0] as Session;
        expect(created.workingDir).toBe(remotePath);
        expect(harness.ctx.addSession).toHaveBeenCalledWith(expect.any(Session), { caseName: 'alice-remote' });
      } finally {
        await cleanup();
      }
    });

    it('infers a managed local case from an exact workingDir-only creation', async () => {
      const caseName = 'working-dir-managed';
      const workingDir = join(CASES_DIR, caseName);
      await mkdir(workingDir, { recursive: true });
      harness.ctx.addSession.mockResolvedValueOnce({
        layout: authoritativeTabLayout,
        placements: authoritativeTabPlacements,
        placementSource: 'case-default',
      });

      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: { workingDir, mode: 'shell' },
      });

      expect(response.statusCode).toBe(200);
      expect(harness.ctx.addSession).toHaveBeenCalledWith(expect.any(Session), { caseName });
      expect(JSON.parse(response.body).data.tabLayout).toEqual(authoritativeTabLayout);
      expect(JSON.parse(response.body).data.tabPlacements).toEqual(authoritativeTabPlacements);
    });

    it('infers an owner-accessible linked local case from an exact workingDir-only creation', async () => {
      const caseName = 'working-dir-linked';
      const linkedDir = await mkdtemp(join(tmpdir(), 'codeman-linked-case-'));
      const linkedCasesFile = dataPath('linked-cases.json');
      await mkdir(dirname(linkedCasesFile), { recursive: true });
      await writeFile(linkedCasesFile, JSON.stringify({ [caseName]: linkedDir }));
      harness.ctx.addSession.mockResolvedValueOnce({
        layout: authoritativeTabLayout,
        placements: authoritativeTabPlacements,
        placementSource: 'case-default',
      });
      try {
        const response = await harness.app.inject({
          method: 'POST',
          url: '/api/sessions',
          payload: { workingDir: linkedDir, mode: 'shell' },
        });

        expect(response.statusCode).toBe(200);
        expect(harness.ctx.addSession).toHaveBeenCalledWith(expect.any(Session), { caseName });
        expect(JSON.parse(response.body).data.tabLayout).toEqual(authoritativeTabLayout);
        expect(JSON.parse(response.body).data.tabPlacements).toEqual(authoritativeTabPlacements);
      } finally {
        await rm(linkedCasesFile, { force: true });
        await rm(linkedDir, { recursive: true, force: true });
      }
    });

    it('does not infer a case from an arbitrary repository with the same basename', async () => {
      const caseName = 'basename-only';
      await mkdir(join(CASES_DIR, caseName), { recursive: true });
      const arbitraryParent = await mkdtemp(join(tmpdir(), 'codeman-arbitrary-repo-'));
      const arbitraryRepo = join(arbitraryParent, caseName);
      await mkdir(arbitraryRepo);
      try {
        const response = await harness.app.inject({
          method: 'POST',
          url: '/api/sessions',
          payload: { workingDir: arbitraryRepo, mode: 'shell' },
        });

        expect(response.statusCode).toBe(200);
        expect(harness.ctx.addSession).toHaveBeenCalledWith(expect.any(Session));
        expect(harness.ctx.addSession.mock.calls.at(-1)).toHaveLength(1);
        expect(JSON.parse(response.body).data).not.toHaveProperty('tabLayout');
      } finally {
        await rm(arbitraryParent, { recursive: true, force: true });
      }
    });

    it('does not infer a case from a child directory beneath a managed case', async () => {
      const childDir = join(CASES_DIR, 'managed-parent', 'child');
      await mkdir(childDir, { recursive: true });

      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: { workingDir: childDir, mode: 'shell' },
      });

      expect(response.statusCode).toBe(200);
      expect(harness.ctx.addSession).toHaveBeenCalledWith(expect.any(Session));
      expect(harness.ctx.addSession.mock.calls.at(-1)).toHaveLength(1);
      expect(JSON.parse(response.body).data).not.toHaveProperty('tabLayout');
    });

    it('does not infer a local case from a registered Docker workspace path', async () => {
      const dockerWorkspace = join(CASES_DIR, 'docker-workspace');
      await mkdir(dockerWorkspace, { recursive: true });
      dockerStore.cases = [
        { name: 'docker-workspace', type: 'docker', hostId: 'docker-local', hostWorkspacePath: dockerWorkspace },
      ];

      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: { workingDir: dockerWorkspace, mode: 'shell' },
      });

      expect(response.statusCode).toBe(200);
      expect(harness.ctx.addSession).toHaveBeenCalledWith(expect.any(Session));
      expect(harness.ctx.addSession.mock.calls.at(-1)).toHaveLength(1);
      expect(JSON.parse(response.body).data).not.toHaveProperty('tabLayout');
    });

    it('keeps an ordinary session creation response and addSession call unchanged', async () => {
      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: { mode: 'shell' },
      });

      expect(response.statusCode).toBe(200);
      expect(harness.ctx.addSession).toHaveBeenCalledWith(expect.any(Session));
      expect(harness.ctx.addSession.mock.calls.at(-1)).toHaveLength(1);
      expect(JSON.parse(response.body).data).not.toHaveProperty('tabLayout');
      expect(JSON.parse(response.body).data).not.toHaveProperty('tabPlacements');
    });

    it.each([
      ['/api/sessions', ''],
      ['/api/sessions', 'x'.repeat(101)],
      ['/api/quick-start', ''],
      ['/api/quick-start', 'x'.repeat(101)],
    ])('rejects invalid tabGroupId for %s', async (url, tabGroupId) => {
      const response = await harness.app.inject({
        method: 'POST',
        url,
        payload: { mode: 'shell', tabGroupId },
      });

      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body).success).toBe(false);
      expect(harness.ctx.addSession).not.toHaveBeenCalled();
    });

    it('returns the authoritative layout for a targeted quick-start', async () => {
      remoteStore.hosts = [{ id: 'gpu-box', label: 'GPU Box', host: '10.0.0.42', username: 'ubuntu', commands: {} }];
      remoteStore.cases = [{ name: 'nzbdav', type: 'remote', hostId: 'gpu-box', remotePath: '/srv/nzbdav' }];
      const startShell = vi.spyOn(Session.prototype, 'startShell').mockResolvedValue(undefined);
      harness.ctx.addSession.mockResolvedValueOnce({
        layout: authoritativeTabLayout,
        placements: authoritativeTabPlacements,
      });
      try {
        const response = await harness.app.inject({
          method: 'POST',
          url: '/api/quick-start',
          payload: { caseName: 'nzbdav', mode: 'shell', tabGroupId: 'work' },
        });

        expect(response.statusCode).toBe(200);
        expect(harness.ctx.addSession).toHaveBeenCalledWith(expect.any(Session), {
          caseName: 'nzbdav',
          tabGroupId: 'work',
        });
        expect(JSON.parse(response.body).data.tabLayout).toEqual(authoritativeTabLayout);
        expect(JSON.parse(response.body).data.tabPlacements).toEqual(authoritativeTabPlacements);
      } finally {
        startShell.mockRestore();
      }
    });

    it('returns the authoritative layout when the case default placed a quick-start session', async () => {
      remoteStore.hosts = [{ id: 'gpu-box', label: 'GPU Box', host: '10.0.0.42', username: 'ubuntu', commands: {} }];
      remoteStore.cases = [{ name: 'nzbdav', type: 'remote', hostId: 'gpu-box', remotePath: '/srv/nzbdav' }];
      const startShell = vi.spyOn(Session.prototype, 'startShell').mockResolvedValue(undefined);
      harness.ctx.addSession.mockResolvedValueOnce({
        layout: authoritativeTabLayout,
        placements: authoritativeTabPlacements,
        placementSource: 'case-default',
      });
      try {
        const response = await harness.app.inject({
          method: 'POST',
          url: '/api/quick-start',
          payload: { caseName: 'nzbdav', mode: 'shell' },
        });

        expect(response.statusCode).toBe(200);
        expect(harness.ctx.addSession).toHaveBeenCalledWith(expect.any(Session), { caseName: 'nzbdav' });
        expect(JSON.parse(response.body).data.tabLayout).toEqual(authoritativeTabLayout);
        expect(JSON.parse(response.body).data.tabPlacements).toEqual(authoritativeTabPlacements);
      } finally {
        startShell.mockRestore();
      }
    });

    it('keeps an ordinary quick-start response and addSession call unchanged', async () => {
      const startShell = vi.spyOn(Session.prototype, 'startShell').mockResolvedValue(undefined);
      try {
        const response = await harness.app.inject({
          method: 'POST',
          url: '/api/quick-start',
          payload: { mode: 'shell' },
        });

        expect(response.statusCode).toBe(200);
        expect(harness.ctx.addSession).toHaveBeenCalledWith(expect.any(Session), { caseName: 'testcase' });
        expect(JSON.parse(response.body).data).not.toHaveProperty('tabLayout');
        expect(JSON.parse(response.body).data).not.toHaveProperty('tabPlacements');
      } finally {
        startShell.mockRestore();
      }
    });
  });

  // ========== POST /api/sessions/:id/send-key ==========

  describe('POST /api/sessions/:id/send-key', () => {
    it('rejects both input routes before sending keys while assistant handoff owns the session', async () => {
      harness.ctx._session.assistantInputLocked = true;
      execFile.mockClear();
      const key = await harness.app.inject({
        method: 'POST',
        url: '/api/sessions/test-session-1/send-key',
        payload: { key: 'S-Enter' },
      });
      const input = await harness.app.inject({
        method: 'POST',
        url: '/api/sessions/test-session-1/input',
        payload: { input: 'must not send\r' },
      });
      expect(key.statusCode).toBe(409);
      expect(input.statusCode).toBe(409);
      expect(execFile).not.toHaveBeenCalled();
      expect(harness.ctx._session.writeBuffer).toEqual([]);
    });
    it('routes tmux send-keys through the dedicated Codeman socket (-L)', async () => {
      // Regression guard: bare `tmux` would hit the user's default server and never
      // find a session that lives only on the Codeman socket (#80 regression class).
      execFile.mockReset();
      execFile.mockImplementation((_bin: string, _argv: string[], _opts: unknown, cb: (e: Error | null) => void) =>
        cb(null)
      );

      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/sessions/test-session-1/send-key',
        payload: { key: 'S-Enter' },
      });

      expect(res.statusCode).toBe(200);
      expect(execFile).toHaveBeenCalledTimes(1);
      const [bin, argv] = execFile.mock.calls[0];
      expect(bin).toBe('tmux');
      expect((argv as string[]).slice(0, 2)).toEqual(['-L', 'codeman']);
      expect(argv).toContain('send-keys');
      expect(argv).toContain('-H');
    });

    describe('newline chord comes from the CLI registry (capabilities.newline)', () => {
      const sentHex = async (mode: string, key: string): Promise<string[]> => {
        execFile.mockReset();
        execFile.mockImplementation((_bin: string, _argv: string[], _opts: unknown, cb: (e: Error | null) => void) =>
          cb(null)
        );
        const session = harness.ctx._session as unknown as { mode: string };
        const before = session.mode;
        session.mode = mode;
        try {
          const res = await harness.app.inject({
            method: 'POST',
            url: '/api/sessions/test-session-1/send-key',
            payload: { key },
          });
          expect(res.statusCode).toBe(200);
        } finally {
          session.mode = before;
        }
        const argv = execFile.mock.calls[0][1] as string[];
        return argv.slice(argv.indexOf('-H') + 3); // after "-H -t <pane>"
      };

      it('sends a line feed for Shift+Enter to a CLI that declares nothing', async () => {
        expect(await sentHex('claude', 'S-Enter')).toEqual(['0a']);
        expect(await sentHex('opencode', 'S-Enter')).toEqual(['0a']);
      });

      it('sends a line feed to Codex too: no stock CLI declares a chord', async () => {
        expect(await sentHex('codex', 'S-Enter')).toEqual(['0a']);
      });

      describe('a CLI that declares esc-enter (here via a user clis.json override of codex)', () => {
        beforeEach(() => {
          const file = registryFilePath();
          mkdirSync(dirname(file), { recursive: true });
          writeFileSync(
            file,
            JSON.stringify({ schemaVersion: 1, clis: { codex: { capabilities: { newline: 'esc-enter' } } } }),
            { mode: 0o600 }
          );
          reloadCliRegistry();
        });
        afterEach(() => {
          rmSync(registryFilePath(), { force: true });
          reloadCliRegistry();
        });

        it('sends Esc+Enter for Shift+Enter, and only to that CLI', async () => {
          expect(await sentHex('codex', 'S-Enter')).toEqual(['1b', '0d']);
          expect(await sentHex('claude', 'S-Enter')).toEqual(['0a']);
        });

        it('still sends a line feed for Ctrl+Enter', async () => {
          expect(await sentHex('codex', 'C-Enter')).toEqual(['0a']);
        });
      });

      it('always sends a line feed for Ctrl+Enter', async () => {
        expect(await sentHex('codex', 'C-Enter')).toEqual(['0a']);
        expect(await sentHex('claude', 'C-Enter')).toEqual(['0a']);
      });

      it('falls back to a line feed for a mode the registry does not know', async () => {
        expect(await sentHex('no-such-cli', 'S-Enter')).toEqual(['0a']);
      });
    });

    it('rejects keys outside the hex allowlist without invoking tmux', async () => {
      execFile.mockReset();
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/sessions/test-session-1/send-key',
        payload: { key: 'rm -rf' },
      });
      expect(JSON.parse(res.body).success).toBe(false);
      expect(execFile).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/sessions/:id/last-response', () => {
    it('returns the parsed last COD response from canonical terminal history', async () => {
      harness.ctx._session.mode = 'codex';
      harness.ctx._session.terminalBuffer = 'stale local byte history';
      (harness.ctx.mux as { captureActivePaneBuffer?: unknown }).captureActivePaneBuffer = vi.fn(() =>
        `
╭──────────────────────────────────────────────────────╮
│ >_ OpenAI Codex (v0.143.0)                           │
╰──────────────────────────────────────────────────────╯

› say again

Final polished answer
With two lines

› Improve documentation in @filename

gpt-5.4 medium · kb · main · Ready · Context 92% left
`.trim()
      );

      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/sessions/test-session-1/last-response',
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.text).toBe('Final polished answer\nWith two lines');
      expect(body.data.hasContext).toBe(true);
      expect(harness.ctx.mux.captureActivePaneBuffer).toHaveBeenCalledWith(
        harness.ctx._session.muxName,
        expect.objectContaining({
          fullHistory: true,
        })
      );
    });

    it('returns labeled COD transcript blocks for full context', async () => {
      harness.ctx._session.mode = 'codex';
      harness.ctx._session.terminalBuffer = '';
      (harness.ctx.mux as { captureActivePaneBuffer?: unknown }).captureActivePaneBuffer = vi.fn(() =>
        `
› i need to create a naming recommendation for project helix

gpt-5.4 medium · kb · main · Ready · Context 100% left

• Explored
  └ Read SKILL.md

Subject: Naming Recommendation for Project Helix

The product helps customers move virtual machine workloads between hypervisors while keeping operations
stable. It improves visibility into application dependencies and reduces
the risk
and effort involved in moving workloads.
`.trim()
      );

      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/sessions/test-session-1/last-response?context=full',
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.messages).toEqual([
        {
          kind: 'prompt',
          label: 'Prompt',
          role: 'user',
          text: 'i need to create a naming recommendation for project helix',
        },
        {
          kind: 'status',
          label: 'Status',
          role: 'assistant',
          text: 'gpt-5.4 medium · kb · main · Ready · Context 100% left',
        },
        { kind: 'tool', label: 'Tool', role: 'assistant', text: '• Explored\n  └ Read SKILL.md' },
        {
          kind: 'response',
          label: 'Response',
          role: 'assistant',
          text: 'Subject: Naming Recommendation for Project Helix\n\nThe product helps customers move virtual machine workloads between hypervisors while keeping operations stable. It improves visibility into application dependencies and reduces the risk and effort involved in moving workloads.',
        },
      ]);
    });
  });

  // ========== POST /api/sessions/:id/paste-image ==========

  describe('POST /api/sessions/:id/paste-image', () => {
    function imageUploadBody(boundary: string, filename: string, mimetype: string, imageBytes: Buffer): Buffer {
      return Buffer.concat([
        Buffer.from(
          `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="image"; filename="${filename}"\r\n` +
            `Content-Type: ${mimetype}\r\n\r\n`
        ),
        imageBytes,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);
    }

    function pngUploadBody(boundary: string, imageBytes: Buffer): Buffer {
      return imageUploadBody(boundary, 'issue.png', 'image/png', imageBytes);
    }

    function makeSessionRemote(remotePath = '/Users/saqebakhter/repos/projects/moneytrove'): void {
      harness.ctx._session.workingDir = remotePath;
      (harness.ctx._session as { remote?: unknown }).remote = {
        hostId: 'mac-mini',
        label: 'mac-mini',
        host: '192.168.21.109',
        username: 'saqebakhter',
        remotePath,
      };
    }

    it('converts HEIC paste images to JPEG attachments when browser-side normalization falls back', async () => {
      const workDir = await mkdtemp(join(tmpdir(), 'codeman-heic-'));
      harness.ctx._session.workingDir = workDir;
      heicConvert.mockClear();
      const boundary = 'codeman-test-boundary';
      const heic = Buffer.from('00000034667479706865696300000000', 'hex');
      try {
        const res = await harness.app.inject({
          method: 'POST',
          url: `/api/sessions/${harness.ctx._sessionId}/paste-image`,
          headers: {
            host: 'codeman.test',
            origin: 'http://codeman.test',
            'content-type': `multipart/form-data; boundary=${boundary}`,
          },
          payload: imageUploadBody(boundary, 'IMG_4996.HEIC', 'image/heic', heic),
        });

        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(body.success).toBe(true);
        expect(body.data.path).toMatch(/\/\.codeman-uploads\/paste-\d+-[a-f0-9]{8}\.jpg$/);
        expect((await readFile(body.data.path)).subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
        expect(heicConvert).toHaveBeenCalledWith(heic);
      } finally {
        await rm(workDir, { recursive: true });
      }
    });

    it('transfers remote images over SSH without creating a local upload directory', async () => {
      const workDir = await mkdtemp(join(tmpdir(), 'codeman-remote-image-'));
      makeSessionRemote(workDir);
      remoteImageWrite.mockClear();
      try {
        const res = await upload('shot.jpg', 'image/jpeg', jpeg);
        expect(res.statusCode).toBe(200);
        const { path, filename } = JSON.parse(res.body).data;
        expect(path).toBe(`${workDir}/.claude-images/${filename}`);
        expect(remoteImageWrite).toHaveBeenCalledWith(
          harness.ctx._session.remote,
          expect.objectContaining({
            dir: `${workDir}/.claude-images`,
            filePath: path,
            bytes: jpeg,
            transferLabel: 'remote image upload',
          })
        );
        expect(await readdir(workDir)).toEqual([]);
      } finally {
        await rm(workDir, { recursive: true });
      }
    });

    it('surfaces SSH transfer errors without returning a successful attachment path', async () => {
      makeSessionRemote();
      remoteImageWrite.mockRejectedValueOnce(new Error('remote image upload failed: Permission denied'));
      const res = await upload('shot.jpg', 'image/jpeg', jpeg);
      expect(res.statusCode).toBe(500);
      expect(JSON.parse(res.body)).toMatchObject({ success: false });
      expect(JSON.parse(res.body).data).toBeUndefined();
    });

    it('validates remote image bytes before attempting an SSH transfer', async () => {
      makeSessionRemote();
      remoteImageWrite.mockClear();
      const res = await upload('shot.jpg', 'image/jpeg', Buffer.from('not a valid image'));
      expect(res.statusCode).toBe(415);
      expect(remoteImageWrite).not.toHaveBeenCalled();
    });

    it('converts mislabeled HEIC (declared image/jpeg, HEIF bytes — the MIUI/Android case) via magic sniff', async () => {
      const workDir = await mkdtemp(join(tmpdir(), 'codeman-heic-mislabel-'));
      harness.ctx._session.workingDir = workDir;
      heicConvert.mockClear();

      const boundary = 'codeman-test-boundary';
      // ftyp brand mif1 — HEIF bytes hiding under a JPEG filename + MIME.
      const heic = Buffer.from('000000346674797061696631000000006d69663168656963', 'hex');
      heic.write('mif1', 8, 'ascii'); // major brand
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/paste-image`,
        headers: {
          host: 'codeman.test',
          origin: 'http://codeman.test',
          'content-type': `multipart/form-data; boundary=${boundary}`,
        },
        payload: imageUploadBody(boundary, 'IMG_2001.jpg', 'image/jpeg', heic),
      });

      await rm(workDir, { recursive: true });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.path).toMatch(/\/\.codeman-uploads\/paste-\d+-[a-f0-9]{8}\.jpg$/);
      expect(heicConvert).toHaveBeenCalledWith(heic);
    });

    const jpeg = Buffer.from('ffd8ffe000104a46494600010100', 'hex');
    const upload = (name: string, mime: string, bytes: Buffer) =>
      harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/paste-image`,
        headers: {
          host: 'codeman.test',
          origin: 'http://codeman.test',
          'content-type': 'multipart/form-data; boundary=codeman-test-boundary',
        },
        payload: imageUploadBody('codeman-test-boundary', name, mime, bytes),
      });

    it('writes into .codeman-uploads with a self-ignoring .gitignore, written once and never over a file already there', async () => {
      const workDir = await mkdtemp(join(tmpdir(), 'codeman-uploads-'));
      harness.ctx._session.workingDir = workDir;
      try {
        const first = await upload('shot.jpg', 'image/jpeg', jpeg);
        expect(first.statusCode).toBe(200);
        expect(JSON.parse(first.body).data.path).toMatch(/\/\.codeman-uploads\/paste-\d+-[a-f0-9]{8}\.jpg$/);
        expect(await readdir(workDir)).toEqual(['.codeman-uploads']);
        expect(await readFile(join(workDir, '.codeman-uploads', '.gitignore'), 'utf8')).toBe('*\n');

        await writeFile(join(workDir, '.codeman-uploads', '.gitignore'), 'theirs\n');
        expect((await upload('shot.jpg', 'image/jpeg', jpeg)).statusCode).toBe(200);
        expect(await readFile(join(workDir, '.codeman-uploads', '.gitignore'), 'utf8')).toBe('theirs\n');
      } finally {
        await rm(workDir, { recursive: true });
      }
    });

    it('takes back an ignore file whose write failed, so the next upload writes a real one', async () => {
      const workDir = await mkdtemp(join(tmpdir(), 'codeman-uploads-'));
      harness.ctx._session.workingDir = workDir;
      const ignoreFile = join(workDir, '.codeman-uploads', '.gitignore');
      // The exclusive create succeeds and the two-byte write fails, as on a full disk.
      const spy = vi.spyOn(fs, 'writeFile').mockImplementationOnce(async (path) => {
        await writeFile(path as string, '');
        throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
      });
      try {
        expect((await upload('shot.jpg', 'image/jpeg', jpeg)).statusCode).toBe(500);
        expect(existsSync(ignoreFile)).toBe(false);
        expect((await upload('shot.jpg', 'image/jpeg', jpeg)).statusCode).toBe(200);
        expect(await readFile(ignoreFile, 'utf8')).toBe('*\n');
      } finally {
        spy.mockRestore();
        await rm(workDir, { recursive: true });
      }
    });

    it('refuses a planted symlink at .codeman-uploads and writes nothing through it', async () => {
      const workDir = await mkdtemp(join(tmpdir(), 'codeman-uploads-'));
      const elsewhere = await mkdtemp(join(tmpdir(), 'codeman-elsewhere-'));
      harness.ctx._session.workingDir = workDir;
      await symlink(elsewhere, join(workDir, '.codeman-uploads'));
      try {
        const res = await upload('shot.jpg', 'image/jpeg', jpeg);
        expect(res.statusCode).toBe(403);
        expect(JSON.parse(res.body).error).toBe('.codeman-uploads is not a regular directory');
        expect(await readdir(elsewhere)).toEqual([]);
      } finally {
        await rm(workDir, { recursive: true });
        await rm(elsewhere, { recursive: true });
      }
    });

    it('refuses incomplete remote connection metadata before touching disk', async () => {
      const workDir = await mkdtemp(join(tmpdir(), 'codeman-uploads-'));
      harness.ctx._session.workingDir = workDir;
      // A remote session's workingDir is the REMOTE path: a file written here is unreadable there.
      (harness.ctx._session as unknown as { remote: unknown }).remote = { hostId: 'gpu-box' };
      try {
        const res = await upload('shot.jpg', 'image/jpeg', jpeg);
        expect(res.statusCode).toBe(400);
        expect(JSON.parse(res.body).error).toMatch(/remote/);
        expect(await readdir(workDir)).toEqual([]);
      } finally {
        (harness.ctx._session as unknown as { remote: unknown }).remote = undefined;
        await rm(workDir, { recursive: true });
      }
    });

    it('returns 415 with the error envelope when HEIC conversion fails', async () => {
      heicConvert.mockClear();
      heicConvert.mockRejectedValueOnce(new Error('HEIC dimensions 30000x30000 exceed the 64MP decode limit'));

      const boundary = 'codeman-test-boundary';
      const heic = Buffer.from('00000034667479706865696300000000', 'hex');
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/paste-image`,
        headers: {
          host: 'codeman.test',
          origin: 'http://codeman.test',
          'content-type': `multipart/form-data; boundary=${boundary}`,
        },
        payload: imageUploadBody(boundary, 'IMG_4997.HEIC', 'image/heic', heic),
      });

      expect(res.statusCode).toBe(415);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.errorCode).toBe('INVALID_INPUT');
      expect(body.error).toMatch(/HEIC/);
    });

    it('rejects ftyp brands heic-decode cannot convert (e.g. heim) without invoking the converter', async () => {
      heicConvert.mockClear();

      const boundary = 'codeman-test-boundary';
      const heim = Buffer.from('00000034667479706865696d00000000', 'hex');
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/paste-image`,
        headers: {
          host: 'codeman.test',
          origin: 'http://codeman.test',
          'content-type': `multipart/form-data; boundary=${boundary}`,
        },
        payload: imageUploadBody(boundary, 'IMG_4998.HEIC', 'image/heic', heim),
      });

      expect(res.statusCode).toBe(415);
      expect(JSON.parse(res.body).success).toBe(false);
      expect(heicConvert).not.toHaveBeenCalled();
    });
  });

  // ========== GET /api/sessions ==========

  describe('GET /api/sessions', () => {
    it('returns session list when sessions exist', async () => {
      const res = await harness.app.inject({ method: 'GET', url: '/api/sessions' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.data).toHaveLength(1);
    });

    it('returns empty array when no sessions', async () => {
      harness.ctx.sessions.clear();
      const res = await harness.app.inject({ method: 'GET', url: '/api/sessions' });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).data).toEqual([]);
    });
  });

  // ========== GET /api/sessions/:id ==========

  describe('GET /api/sessions/:id', () => {
    it('returns session state for existing session', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.id).toBe(harness.ctx._sessionId);
    });

    it('returns error for unknown session', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/sessions/nonexistent',
      });
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.error).toBeDefined();
    });
  });

  // ========== PUT /api/sessions/:id/name ==========

  describe('PUT /api/sessions/:id/name', () => {
    it('persists the renamed session immediately so restart restore keeps the custom name', async () => {
      const res = await harness.app.inject({
        method: 'PUT',
        url: `/api/sessions/${harness.ctx._sessionId}/name`,
        payload: { name: 'Custom restart-safe name' },
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toMatchObject({ success: true, data: { name: 'Custom restart-safe name' } });
      expect(harness.ctx._session.name).toBe('Custom restart-safe name');
      expect(harness.ctx.mux.updateSessionName).toHaveBeenCalledWith(
        harness.ctx._sessionId,
        'Custom restart-safe name'
      );
      expect(harness.ctx.persistSessionStateNow).toHaveBeenCalledWith(harness.ctx._session);
      expect(harness.ctx.persistSessionState).not.toHaveBeenCalled();
    });
  });

  // ========== DELETE /api/sessions/:id ==========

  describe('DELETE /api/sessions/:id', () => {
    it('deletes existing session', async () => {
      const res = await harness.app.inject({
        method: 'DELETE',
        url: `/api/sessions/${harness.ctx._sessionId}`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(harness.ctx.cleanupSession).toHaveBeenCalledWith(harness.ctx._sessionId, true, 'user_delete');
    });

    it('returns error for unknown session', async () => {
      const res = await harness.app.inject({
        method: 'DELETE',
        url: '/api/sessions/nonexistent',
      });
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });

    it('removes a persisted-only session (not live) via the state store, without touching cleanupSession', async () => {
      vi.mocked(harness.ctx.store.getSession).mockReturnValueOnce({
        id: 'ghost-session',
        owner: undefined,
      } as never);
      const res = await harness.app.inject({
        method: 'DELETE',
        url: '/api/sessions/ghost-session',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(harness.ctx.store.demoteOrRemoveSession).toHaveBeenCalledWith('ghost-session');
      expect(harness.ctx.cleanupSession).not.toHaveBeenCalled();
      // Ark0N/Codeman#353 review: the persisted-only branch used to demote/remove
      // with no broadcast, so other open tabs kept showing the retired row until
      // their next unrelated fetch.
      expect(harness.ctx.broadcast).toHaveBeenCalledWith('session:deleted', { id: 'ghost-session' });
    });

    it('404s a persisted-only session id the state store does not recognize either', async () => {
      vi.mocked(harness.ctx.store.getSession).mockReturnValueOnce(null);
      const res = await harness.app.inject({
        method: 'DELETE',
        url: '/api/sessions/truly-nonexistent',
      });
      expect(res.statusCode).toBe(404);
      expect(harness.ctx.store.demoteOrRemoveSession).not.toHaveBeenCalled();
    });
  });

  // ========== DELETE /api/sessions (delete all) ==========

  describe('DELETE /api/sessions', () => {
    it('deletes all sessions', async () => {
      const res = await harness.app.inject({
        method: 'DELETE',
        url: '/api/sessions',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.killed).toBe(1);
      expect(harness.ctx.cleanupSession).toHaveBeenCalled();
    });
  });

  // ========== PUT /api/sessions/:id/name ==========

  describe('PUT /api/sessions/:id/name', () => {
    it('renames session', async () => {
      const res = await harness.app.inject({
        method: 'PUT',
        url: `/api/sessions/${harness.ctx._sessionId}/name`,
        payload: { name: 'new-name' },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.name).toBe('new-name');
      expect(harness.ctx.persistSessionStateNow).toHaveBeenCalled();
      expect(harness.ctx.broadcast).toHaveBeenCalledWith('session:updated', expect.anything());
    });

    it('returns error for unknown session', async () => {
      const res = await harness.app.inject({
        method: 'PUT',
        url: '/api/sessions/nonexistent/name',
        payload: { name: 'test' },
      });
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });
  });

  // ========== PUT /api/sessions/:id/color ==========

  describe('PUT /api/sessions/:id/color', () => {
    it('sets session color', async () => {
      const res = await harness.app.inject({
        method: 'PUT',
        url: `/api/sessions/${harness.ctx._sessionId}/color`,
        payload: { color: 'blue' },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.color).toBe('blue');
    });

    it('rejects invalid color', async () => {
      const res = await harness.app.inject({
        method: 'PUT',
        url: `/api/sessions/${harness.ctx._sessionId}/color`,
        payload: { color: 'neon-rainbow' },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });
  });

  // ========== POST /api/sessions/:id/auto-resume ==========

  describe('POST /api/sessions/:id/auto-resume', () => {
    it('enables auto-resume on usage limit', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/auto-resume`,
        payload: { enabled: true },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.autoResume.enabled).toBe(true);
      const session = harness.ctx.sessions.get(harness.ctx._sessionId)!;
      expect(session.setAutoResume).toHaveBeenCalledWith(true);
      expect(harness.ctx.persistSessionState).toHaveBeenCalled();
      expect(harness.ctx.broadcast).toHaveBeenCalledWith('session:updated', expect.anything());
    });

    it('disables auto-resume', async () => {
      const session = harness.ctx.sessions.get(harness.ctx._sessionId)!;
      session.autoResumeEnabled = true;
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/auto-resume`,
        payload: { enabled: false },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.autoResume.enabled).toBe(false);
      expect(session.setAutoResume).toHaveBeenCalledWith(false);
    });

    it('rejects invalid body', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/auto-resume`,
        payload: { enabled: 'yes' },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.errorCode).toBe(ApiErrorCode.INVALID_INPUT);
    });

    it('returns 404 for unknown session', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/sessions/nonexistent/auto-resume',
        payload: { enabled: true },
      });
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });
  });

  // ========== POST /api/sessions/:id/input ==========

  describe('POST /api/sessions/:id/input', () => {
    it('sends input to session', async () => {
      harness.ctx._session.isCheckpointActive = true;
      const info = vi.spyOn(console, 'info').mockImplementation(() => {});
      const session = harness.ctx._session;
      const write = vi.spyOn(session, 'write');
      try {
        const res = await harness.app.inject({
          method: 'POST',
          url: `/api/sessions/${harness.ctx._sessionId}/input`,
          payload: { input: 'hello' },
        });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(body.success).toBe(true);
        expect(session.cancelCheckpoint).toHaveBeenCalledWith('manual-takeover');
        expect(info).toHaveBeenCalledWith('[Checkpoint] manual takeover', {
          sessionId: harness.ctx._sessionId,
          route: 'http',
          inputClass: 'keyboard',
        });
        expect(JSON.stringify(info.mock.calls)).not.toContain('hello');
        expect(session.cancelCheckpoint.mock.invocationCallOrder[0]).toBeLessThan(write.mock.invocationCallOrder[0]);
      } finally {
        write.mockRestore();
        info.mockRestore();
      }
    });

    it.each(['\x1b[O', '\x1b[<64;10;5M', '\x1b[M !!'])('forwards report-only input without takeover', async (input) => {
      const session = harness.ctx._session;
      session.isCheckpointActive = true;
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/input`,
        payload: { input },
      });
      expect(res.statusCode).toBe(200);
      expect(session.writeBuffer).toContain(input);
      expect(session.cancelCheckpoint).not.toHaveBeenCalled();
    });

    it('cancels for mixed report and keyboard input', async () => {
      const session = harness.ctx._session;
      session.isCheckpointActive = true;
      const input = '\x1b[Ox';
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/input`,
        payload: { input },
      });
      expect(res.statusCode).toBe(200);
      expect(session.cancelCheckpoint).toHaveBeenCalledWith('manual-takeover');
    });

    it('returns error for unknown session', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/sessions/nonexistent/input',
        payload: { input: 'hello' },
      });
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });

    it('rejects empty payload', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/input`,
        payload: {},
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });

    it('applies a tagged (clientId, seq) input exactly once on redelivery', async () => {
      const url = `/api/sessions/${harness.ctx._sessionId}/input`;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const session = harness.ctx.sessions.get(harness.ctx._sessionId) as any;
      session.writeBuffer.length = 0;

      const post = (payload: unknown) => harness.app.inject({ method: 'POST', url, payload });

      // First delivery of seq 1 — applied (200, written once).
      const first = await post({ input: 'prompt', seq: 1, clientId: 'cid-1' });
      expect(first.statusCode).toBe(200);
      session.cancelCheckpoint.mockClear();

      // Redelivery of the SAME seq (client never saw the ACK) — still 200, but
      // must NOT write again.
      const dup = await post({ input: 'prompt', seq: 1, clientId: 'cid-1' });
      expect(dup.statusCode).toBe(200);
      expect(session.cancelCheckpoint).not.toHaveBeenCalled();

      // A genuinely new seq — applied.
      const next = await post({ input: '\r', seq: 2, clientId: 'cid-1' });
      expect(next.statusCode).toBe(200);
      expect(session.cancelCheckpoint).toHaveBeenCalledOnce();

      expect(session.writeBuffer).toEqual(['prompt', '\r']);
    });

    it('always applies untagged input (curl/legacy, no dedup)', async () => {
      const url = `/api/sessions/${harness.ctx._sessionId}/input`;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const session = harness.ctx.sessions.get(harness.ctx._sessionId) as any;
      session.writeBuffer.length = 0;

      const post = () => harness.app.inject({ method: 'POST', url, payload: { input: 'x' } });
      await post();
      await post();
      // No seq/clientId ⇒ no dedup ⇒ both writes land.
      expect(session.writeBuffer).toEqual(['x', 'x']);
    });
  });

  // ========== POST /api/sessions/:id/resize ==========

  describe('POST /api/sessions/:id/resize', () => {
    it('allows ownerless new-session initialization through the legacy HTTP route', async () => {
      const resizeIfOwnerless = vi.fn(() => true);
      Object.assign(harness.ctx._session, { resizeIfNoActiveTerminalViewer: resizeIfOwnerless });
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/resize`,
        payload: { cols: 120, rows: 40 },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(resizeIfOwnerless).toHaveBeenCalledWith(120, 40);
      expect(harness.ctx._session.resize).not.toHaveBeenCalled();
    });

    it('rejects a cached-tab HTTP resize while an active viewer owns sizing', async () => {
      const resizeIfOwnerless = vi.fn(() => false);
      Object.assign(harness.ctx._session, { resizeIfNoActiveTerminalViewer: resizeIfOwnerless });
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/resize`,
        payload: { cols: 48, rows: 28, viewportType: 'mobile' },
      });
      expect(res.statusCode).toBe(409);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.errorCode).toBe('CONFLICT');
      expect(body.error).toContain('active terminal viewer');
      expect(resizeIfOwnerless).toHaveBeenCalledWith(48, 28);
      expect(harness.ctx._session.resize).not.toHaveBeenCalled();
    });

    it('keeps cached force flags from bypassing the ownerless admission gate', async () => {
      const resizeIfOwnerless = vi.fn(() => false);
      Object.assign(harness.ctx._session, { resizeIfNoActiveTerminalViewer: resizeIfOwnerless });
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/resize`,
        payload: { cols: 120, rows: 40, force: true },
      });
      expect(res.statusCode).toBe(409);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.errorCode).toBe('CONFLICT');
      expect(resizeIfOwnerless).toHaveBeenCalledWith(120, 40);
      expect(harness.ctx._session.resize).not.toHaveBeenCalled();
    });

    it('rejects cols exceeding max (500)', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/resize`,
        payload: { cols: 501, rows: 24 },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });

    it('rejects rows exceeding max (200)', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/resize`,
        payload: { cols: 80, rows: 201 },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });

    it('rejects zero dimensions', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/resize`,
        payload: { cols: 0, rows: 24 },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });
  });

  // ========== GET /api/sessions/:id/terminal ==========

  describe('GET /api/sessions/:id/terminal', () => {
    it('returns terminal buffer', async () => {
      harness.ctx._session.terminalBuffer = 'hello world';
      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/terminal`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.terminalBuffer).toBeDefined();
    });

    // ── #258: a single `truncated` boolean could not distinguish "we tailed for
    // speed, the rest is still there" from "the oldest bytes are gone". The UI
    // needs that difference to know whether offering "Load full history" is a
    // promise it can keep.
    describe('truncation reason (#258)', () => {
      const lines = (n: number) => Array.from({ length: n }, (_, i) => `history line ${i}`).join('\n');

      beforeEach(() => {
        (harness.ctx.mux as { captureActivePaneBuffer?: unknown }).captureActivePaneBuffer = vi.fn(() => null);
        harness.ctx._session.mode = 'shell';
      });

      it('reports no reason when nothing was cut', async () => {
        harness.ctx._session.terminalBuffer = 'short buffer';
        const res = await harness.app.inject({
          method: 'GET',
          url: `/api/sessions/${harness.ctx._sessionId}/terminal`,
        });
        const body = JSON.parse(res.body);
        expect(body.data.truncated).toBe(false);
        expect(body.data.truncationReason).toBeNull();
        expect(body.data.retainedBytes).toBe(body.data.terminalBuffer.length);
      });

      it("reports 'tail' for an intentional partial replay", async () => {
        harness.ctx._session.terminalBuffer = lines(4000);
        const res = await harness.app.inject({
          method: 'GET',
          url: `/api/sessions/${harness.ctx._sessionId}/terminal?tail=500`,
        });
        const body = JSON.parse(res.body);
        expect(body.data.truncated).toBe(true);
        expect(body.data.truncationReason).toBe('tail');
        // fullSize describes what existed, retainedBytes what was sent.
        expect(body.data.retainedBytes).toBeLessThan(body.data.fullSize);
      });

      it("reports 'capped' when the byte ceiling dropped the oldest output", async () => {
        harness.ctx.getTerminalHistoryConfig = vi.fn(async () => ({
          ...resolveTerminalHistoryConfig({}),
          terminalBufferMaxBytes: 2000,
        }));
        harness.ctx._session.terminalBuffer = lines(4000);

        const res = await harness.app.inject({
          method: 'GET',
          url: `/api/sessions/${harness.ctx._sessionId}/terminal`,
        });
        const body = JSON.parse(res.body);
        expect(body.data.truncated).toBe(true);
        expect(body.data.truncationReason).toBe('capped');
      });

      it("keeps 'capped' when a tail cut lands on top of it", async () => {
        // Both sites fire. 'capped' is the stronger statement (bytes are gone),
        // so a subsequent tail must not downgrade it to the recoverable reason.
        harness.ctx.getTerminalHistoryConfig = vi.fn(async () => ({
          ...resolveTerminalHistoryConfig({}),
          terminalBufferMaxBytes: 2000,
        }));
        harness.ctx._session.terminalBuffer = lines(4000);

        const res = await harness.app.inject({
          method: 'GET',
          url: `/api/sessions/${harness.ctx._sessionId}/terminal?tail=500`,
        });
        const body = JSON.parse(res.body);
        expect(body.data.truncationReason).toBe('capped');
      });
    });

    it('does not strip VPA-like shell scrollback as Ink redraw bloat', async () => {
      const shellHistory = Array.from(
        { length: 3000 },
        (_, index) => `SHELL_SCROLLBACK_${String(index + 1).padStart(6, '0')} payload payload payload \x1b[1d`
      ).join('\n');
      harness.ctx._session.terminalBuffer = shellHistory;
      harness.ctx._session.mode = 'shell';
      (harness.ctx.mux as { captureActivePaneBuffer?: unknown }).captureActivePaneBuffer = vi.fn(() => null);

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/terminal`,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.terminalBuffer).toContain('SHELL_SCROLLBACK_000001');
      expect(body.data.terminalBuffer).toContain('SHELL_SCROLLBACK_003000');
    });

    it('does not duplicate the latest Codex prompt tail when full tmux history already contains it', async () => {
      const duplicateTail =
        '› Find and fix a bug in @filename\n' + 'gpt-5.5 medium · ~/syncthing/contexts/openshift-base-install';
      harness.ctx._session.terminalBuffer = `hello world\nlater accumulated history\n${duplicateTail}`;
      harness.ctx._session.mode = 'codex';
      (harness.ctx.mux as { captureActivePaneBuffer?: unknown }).captureActivePaneBuffer = vi.fn(
        () => `tmux full history\n${duplicateTail}`
      );

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/terminal`,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.terminalBuffer).toBe(`tmux full history\n${duplicateTail}`);
      expect(body.data.terminalBuffer).not.toContain('hello world');
      expect(body.data.terminalBuffer).not.toContain('\x1b[H\x1b[2J');
      expect(body.data.terminalBuffer.match(/Find and fix a bug in @filename/g)).toHaveLength(1);
      expect(harness.ctx.mux.captureActivePaneBuffer).toHaveBeenCalledWith(
        harness.ctx._session.muxName,
        expect.objectContaining({
          fullHistory: true,
        })
      );
    });

    it('preserves accumulated history before the visible mux pane snapshot on tab switch (claude)', async () => {
      harness.ctx._session.terminalBuffer = 'hello world\nlater accumulated history';
      harness.ctx._session.mode = 'claude';
      (harness.ctx.mux as { captureActivePaneBuffer?: unknown }).captureActivePaneBuffer = vi.fn(
        () => 'visible tmux pane only\n❯ current prompt'
      );

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/terminal?tail=65536`,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.terminalBuffer).toContain('hello world');
      expect(body.data.terminalBuffer).toContain('later accumulated history');
      expect(body.data.terminalBuffer).toContain('\x1b[H\x1b[2Jvisible tmux pane only');
      expect(body.data.terminalBuffer.indexOf('hello world')).toBeLessThan(
        body.data.terminalBuffer.indexOf('visible tmux pane only')
      );
      // A tab-switch tail request captures the visible pane.
      expect(harness.ctx.mux.captureActivePaneBuffer).toHaveBeenCalledWith(
        harness.ctx._session.muxName,
        expect.not.objectContaining({ fullHistory: true })
      );
    });

    // ── The geometry a capture was taken at ──
    //
    // A visible-frame capture repaints each row at an absolute position
    // (`\x1b[<row>;1H`). A terminal with fewer rows than the pane clamps every
    // address past its own height onto its last line, so the overflow rows
    // overwrite each other and the rows they land on are lost. The client can
    // only notice that if the response says what height the frame was built
    // for, which is what captureRows/captureCols carry.

    it('reports the geometry the capture was really taken at', async () => {
      harness.ctx._session.terminalBuffer = '';
      (harness.ctx.mux as { captureActivePaneBuffer?: unknown }).captureActivePaneBuffer = vi.fn(
        (_name: string, opts?: { capturedGeometry?: { cols: number; rows: number } }) => {
          // Stand in for TmuxManager, which fills this from the pane itself.
          if (opts) opts.capturedGeometry = { cols: 100, rows: 50 };
          return 'visible frame';
        }
      );

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/terminal?tail=65536`,
      });

      const body = JSON.parse(res.body);
      expect(body.data.source).toBe('mux-visible');
      expect(body.data.captureCols).toBe(100);
      expect(body.data.captureRows).toBe(50);
    });

    it('omits the geometry when the capture reports none', async () => {
      // The cursor query can fail, and a byte-history response never captures
      // at all. Neither frame was positioned, so neither can be damaged by a
      // terminal of the wrong size. Naming the session's own PTY size here
      // would describe a geometry no frame was built for, and the client would
      // read it as a mismatch worth replaying for.
      harness.ctx._session.terminalBuffer = 'byte history only';
      (harness.ctx.mux as { captureActivePaneBuffer?: unknown }).captureActivePaneBuffer = vi.fn(() => null);

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/terminal`,
      });

      const body = JSON.parse(res.body);
      expect(body.data.source).toBe('history');
      expect(body.data.captureCols).toBeUndefined();
      expect(body.data.captureRows).toBeUndefined();
    });

    it('omits the geometry when the capture reported a size but returned nothing', async () => {
      // A capture can report geometry and still hand back no frame. The
      // full-history path writes `capturedGeometry` from the cursor query, then
      // returns '' for a pane holding nothing visible, which drops the source
      // to `history` with the geometry already recorded. Reporting it there
      // would name a size for a body that is the byte stream.
      harness.ctx._session.terminalBuffer = 'byte history only';
      (harness.ctx.mux as { captureActivePaneBuffer?: unknown }).captureActivePaneBuffer = vi.fn(
        (_name: string, opts?: { capturedGeometry?: { cols: number; rows: number } }) => {
          if (opts) opts.capturedGeometry = { cols: 100, rows: 50 };
          return '';
        }
      );

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/terminal?full=1`,
      });

      const body = JSON.parse(res.body);
      expect(body.data.source).toBe('history');
      expect(body.data.captureCols).toBeUndefined();
      expect(body.data.captureRows).toBeUndefined();
    });

    // ── COD-178: TUI modes replay the tmux capture ONLY — raw byte history is
    // full-screen redraw frames painted at historical window sizes; replaying
    // them at the browser's current row count scrolls each frame into
    // scrollback, stacking stale banner boxes. ──
    it('COD-178: codex full reload drops raw byte history even when the prompt-tail heuristic misses', async () => {
      // Prompt rendered via erase-char + cursor-forward (\x1b[1X\x1b[C) instead of a
      // literal space — the real prod byte stream that defeated the old
      // hasDuplicateCodexPromptTail text comparison.
      harness.ctx._session.terminalBuffer =
        '\x1b[H\x1b[1;40rstale banner frame one\n\x1b[Hstale banner frame two\n' +
        '›\x1b[1X\x1b[2m\x1b[CUse /skills to list available skills\x1b[0m\n' +
        'gpt-5.5 medium · ~/case';
      harness.ctx._session.mode = 'codex';
      (harness.ctx.mux as { captureActivePaneBuffer?: unknown }).captureActivePaneBuffer = vi.fn(
        () => 'clean full capture\n› Use /skills to list available skills\ngpt-5.5 medium · ~/case'
      );

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/terminal`,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.terminalBuffer).toContain('clean full capture');
      expect(body.data.terminalBuffer).not.toContain('stale banner frame');
      expect(body.data.terminalBuffer).not.toContain('\x1b[H\x1b[2J');
      expect(body.data.source).toBe('mux-full-history');
      expect(harness.ctx.mux.captureActivePaneBuffer).toHaveBeenCalledWith(
        harness.ctx._session.muxName,
        expect.objectContaining({
          fullHistory: true,
        })
      );
    });

    it('COD-178: codex tab switch (tail) replays the full tmux capture instead of raw byte history', async () => {
      harness.ctx._session.terminalBuffer = 'stale redraw history';
      harness.ctx._session.mode = 'codex';
      (harness.ctx.mux as { captureActivePaneBuffer?: unknown }).captureActivePaneBuffer = vi.fn(
        (_name: string, opts?: { fullHistory?: boolean }) =>
          opts?.fullHistory ? 'full capture scrollback\n› current prompt' : 'visible frame only'
      );

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/terminal?tail=65536`,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.terminalBuffer).toContain('full capture scrollback');
      expect(body.data.terminalBuffer).not.toContain('stale redraw history');
      expect(body.data.terminalBuffer).not.toContain('visible frame only');
      expect(harness.ctx.mux.captureActivePaneBuffer).toHaveBeenCalledWith(
        harness.ctx._session.muxName,
        expect.objectContaining({
          fullHistory: true,
        })
      );
    });

    it('COD-178: gemini full reload replays the tmux capture only', async () => {
      harness.ctx._session.terminalBuffer = 'stale gemini redraw frames';
      harness.ctx._session.mode = 'gemini';
      (harness.ctx.mux as { captureActivePaneBuffer?: unknown }).captureActivePaneBuffer = vi.fn(
        () => 'gemini clean capture'
      );

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/terminal`,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.terminalBuffer).toContain('gemini clean capture');
      expect(body.data.terminalBuffer).not.toContain('stale gemini redraw frames');
    });

    it('COD-207: opencode lines=N capture request is capture-only and returns full-history source', async () => {
      harness.ctx._session.terminalBuffer = 'opencode byte history';
      harness.ctx._session.mode = 'opencode';
      const linesCaptureSpy = vi.fn((_name: string, opts?: { fullHistory?: boolean; lastLines?: number }) =>
        opts?.fullHistory ? 'opencode full capture' : 'visible'
      );
      (harness.ctx.mux as { captureActivePaneBuffer?: unknown }).captureActivePaneBuffer = linesCaptureSpy;

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/terminal?lines=2000`,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.terminalBuffer).toBe('opencode full capture');
      expect(body.data.terminalBuffer).not.toContain('opencode byte history');
      expect(body.data.source).toBe('mux-full-history');
      expect(linesCaptureSpy).toHaveBeenCalledWith(
        harness.ctx._session.muxName,
        expect.objectContaining({
          fullHistory: true,
          lastLines: 2000,
        })
      );
    });

    it('COD-207: opencode capture=1 request is capture-only and returns full-history source', async () => {
      harness.ctx._session.terminalBuffer = 'opencode byte history';
      harness.ctx._session.mode = 'opencode';
      const captureSpy = vi.fn((_name: string, opts?: { fullHistory?: boolean }) =>
        opts?.fullHistory ? 'opencode capture expansion' : 'visible'
      );
      (harness.ctx.mux as { captureActivePaneBuffer?: unknown }).captureActivePaneBuffer = captureSpy;

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/terminal?capture=1`,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.terminalBuffer).toBe('opencode capture expansion');
      expect(body.data.terminalBuffer).not.toContain('opencode byte history');
      expect(body.data.source).toBe('mux-full-history');
    });

    it('COD-207: opencode full reload replays the tmux capture only', async () => {
      harness.ctx._session.terminalBuffer = 'stale opencode byte history';
      harness.ctx._session.mode = 'opencode';
      const fullReloadSpy = vi.fn(() => 'opencode canonical full capture');
      (harness.ctx.mux as { captureActivePaneBuffer?: unknown }).captureActivePaneBuffer = fullReloadSpy;

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/terminal`,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.terminalBuffer).toBe('opencode canonical full capture');
      expect(body.data.terminalBuffer).not.toContain('stale opencode byte history');
      expect(body.data.source).toBe('mux-full-history');
      expect(fullReloadSpy).toHaveBeenCalledWith(
        harness.ctx._session.muxName,
        expect.objectContaining({
          fullHistory: true,
        })
      );
    });

    // ── COD-180: remote sessions capture from the REMOTE tmux server — the
    // local wrapper accumulates no history (nested tmux repaints in place). ──
    it('COD-180: remote codex session replays the remote tmux capture only', async () => {
      harness.ctx._session.terminalBuffer = 'stale local byte history';
      harness.ctx._session.mode = 'codex';
      (harness.ctx._session as { remote?: unknown }).remote = {
        hostId: 'mac-mini',
        host: '192.168.21.109',
        username: 'saqebakhter',
        remotePath: '/tmp/case',
      };
      const remoteSpy = vi.fn(async () => 'remote canonical scrollback\n› prompt');
      const localSpy = vi.fn(() => 'local wrapper single screen');
      (harness.ctx.mux as { captureRemotePaneBuffer?: unknown }).captureRemotePaneBuffer = remoteSpy;
      (harness.ctx.mux as { captureActivePaneBuffer?: unknown }).captureActivePaneBuffer = localSpy;

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/terminal`,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.terminalBuffer).toContain('remote canonical scrollback');
      expect(body.data.terminalBuffer).not.toContain('stale local byte history');
      expect(body.data.terminalBuffer).not.toContain('local wrapper single screen');
      expect(body.data.source).toBe('mux-full-history');
      expect(remoteSpy).toHaveBeenCalledWith(
        (harness.ctx._session as { remote?: unknown }).remote,
        harness.ctx._sessionId,
        harness.ctx._session.muxName,
        { fullHistory: true }
      );
      expect(localSpy).not.toHaveBeenCalled();
    });

    it('COD-180: remote codex keeps byte history when the remote capture fails (never one local screen)', async () => {
      harness.ctx._session.terminalBuffer = 'accumulated byte history scrollback';
      harness.ctx._session.mode = 'codex';
      (harness.ctx._session as { remote?: unknown }).remote = {
        hostId: 'mac-mini',
        host: '192.168.21.109',
        username: 'saqebakhter',
        remotePath: '/tmp/case',
      };
      (harness.ctx.mux as { captureRemotePaneBuffer?: unknown }).captureRemotePaneBuffer = vi.fn(async () => null);
      (harness.ctx.mux as { captureActivePaneBuffer?: unknown }).captureActivePaneBuffer = vi.fn(
        () => 'local wrapper single screen'
      );

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/terminal`,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      // Degraded mode: byte history + separator + local screen — NOT capture-only,
      // so the session's whole scrollback is never replaced by ~30 local lines.
      expect(body.data.terminalBuffer).toContain('accumulated byte history scrollback');
      expect(body.data.terminalBuffer).toContain('\x1b[H\x1b[2Jlocal wrapper single screen');
      // A degraded response must not advertise itself as a canonical rewrite source.
      expect(body.data.source).toBe('mux-visible');
    });

    it('COD-463: flags full and frame responses while the remote host is in capture backoff', async () => {
      harness.ctx._session.mode = 'codex';
      const remote = { hostId: 'ubuntu-worker', host: '192.168.20.91', username: 'ubuntu', remotePath: '/tmp/case' };
      (harness.ctx._session as { remote?: unknown }).remote = remote;
      const degraded = vi.fn(() => true);
      const mux = harness.ctx.mux as Record<string, unknown>;
      mux.captureRemotePaneBuffer = vi.fn(async () => null);
      mux.captureActivePaneBuffer = vi.fn(() => 'local wrapper single screen');
      mux.isRemoteCaptureDegraded = degraded;

      for (const query of ['?full=1', '?frame=1']) {
        const res = await harness.app.inject({
          method: 'GET',
          url: `/api/sessions/${harness.ctx._sessionId}/terminal${query}`,
        });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(body.data.remoteCaptureDegraded, query).toBe(true);
        expect(body.data.terminalBuffer, query).toContain('local wrapper single screen');
      }
      expect(degraded).toHaveBeenCalledWith(remote);

      degraded.mockReturnValue(false);
      const healthy = JSON.parse(
        (await harness.app.inject({ method: 'GET', url: `/api/sessions/${harness.ctx._sessionId}/terminal?frame=1` }))
          .body
      );
      expect(healthy.data.remoteCaptureDegraded).toBeUndefined();
    });

    it('COD-463: local sessions never carry the remote-capture flag', async () => {
      harness.ctx._session.mode = 'codex';
      const degraded = vi.fn(() => true);
      const mux = harness.ctx.mux as Record<string, unknown>;
      mux.captureActivePaneBuffer = vi.fn(() => 'local full capture');
      mux.isRemoteCaptureDegraded = degraded;

      const body = JSON.parse(
        (await harness.app.inject({ method: 'GET', url: `/api/sessions/${harness.ctx._sessionId}/terminal?full=1` }))
          .body
      );
      expect(body.data.remoteCaptureDegraded).toBeUndefined();
      expect(degraded).not.toHaveBeenCalled();
    });

    it('COD-180: local sessions never attempt a remote capture', async () => {
      harness.ctx._session.terminalBuffer = 'local history';
      harness.ctx._session.mode = 'codex';
      const remoteSpy = vi.fn(async () => 'should not be called');
      (harness.ctx.mux as { captureRemotePaneBuffer?: unknown }).captureRemotePaneBuffer = remoteSpy;
      (harness.ctx.mux as { captureActivePaneBuffer?: unknown }).captureActivePaneBuffer = vi.fn(
        () => 'local full capture'
      );

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/terminal`,
      });

      expect(res.statusCode).toBe(200);
      expect(remoteSpy).not.toHaveBeenCalled();
      expect(JSON.parse(res.body).data.terminalBuffer).toContain('local full capture');
    });

    // ── COD-187 claude expansion: history-view requests are capture-only for
    // any mode; claude's legacy no-param reload keeps its concat. ──
    it('claude lines= request is capture-only (history view first page)', async () => {
      harness.ctx._session.terminalBuffer = 'claude byte history';
      harness.ctx._session.mode = 'claude';
      (harness.ctx.mux as { captureActivePaneBuffer?: unknown }).captureActivePaneBuffer = vi.fn(
        (_n: string, opts?: { fullHistory?: boolean }) => (opts?.fullHistory ? 'claude pane history' : 'v')
      );
      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/terminal?lines=2000`,
      });
      const body = JSON.parse(res.body);
      expect(body.data.terminalBuffer).toContain('claude pane history');
      expect(body.data.terminalBuffer).not.toContain('claude byte history');
      expect(body.data.source).toBe('mux-full-history');
    });

    it('claude capture=1 request is capture-only (history view full expansion)', async () => {
      harness.ctx._session.terminalBuffer = 'claude byte history';
      harness.ctx._session.mode = 'claude';
      (harness.ctx.mux as { captureActivePaneBuffer?: unknown }).captureActivePaneBuffer = vi.fn(
        (_n: string, opts?: { fullHistory?: boolean }) => (opts?.fullHistory ? 'claude full capture' : 'v')
      );
      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/terminal?capture=1`,
      });
      const body = JSON.parse(res.body);
      expect(body.data.terminalBuffer).toContain('claude full capture');
      expect(body.data.terminalBuffer).not.toContain('claude byte history');
    });

    it('claude legacy full reload keeps byte history + capture concat (unchanged)', async () => {
      harness.ctx._session.terminalBuffer = 'claude byte history';
      harness.ctx._session.mode = 'claude';
      (harness.ctx.mux as { captureActivePaneBuffer?: unknown }).captureActivePaneBuffer = vi.fn(
        (_n: string, opts?: { fullHistory?: boolean }) => (opts?.fullHistory ? 'claude full capture' : 'v')
      );
      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/terminal`,
      });
      const body = JSON.parse(res.body);
      expect(body.data.terminalBuffer).toContain('claude byte history');
      expect(body.data.terminalBuffer).toContain('claude full capture');
    });

    // ── COD-189: shell FULL reloads are capture-canonical (byte history is
    // sparse after fast bursts — tmux jump-scroll); tail path unchanged. ──
    it('COD-189: shell full reload replays the capture only (no sparse byte history)', async () => {
      harness.ctx._session.terminalBuffer = 'sparse burst history with holes';
      harness.ctx._session.mode = 'shell';
      (harness.ctx.mux as { captureActivePaneBuffer?: unknown }).captureActivePaneBuffer = vi.fn(
        (_n: string, opts?: { fullHistory?: boolean }) => (opts?.fullHistory ? 'contiguous pane history' : 'visible')
      );

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/terminal`,
      });

      const body = JSON.parse(res.body);
      expect(body.data.terminalBuffer).toContain('contiguous pane history');
      expect(body.data.terminalBuffer).not.toContain('sparse burst history');
      expect(body.data.source).toBe('mux-full-history');
    });

    it('COD-189: shell tail/tab-switch path still serves byte history (fast path unchanged)', async () => {
      harness.ctx._session.terminalBuffer = 'recent shell history';
      harness.ctx._session.mode = 'shell';
      (harness.ctx.mux as { captureActivePaneBuffer?: unknown }).captureActivePaneBuffer = vi.fn(() => 'visible frame');

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/terminal?tail=65536`,
      });

      const body = JSON.parse(res.body);
      expect(body.data.terminalBuffer).toContain('recent shell history');
    });

    // ── COD-187: live mirror — ?frame=1 returns ONLY the current visible frame ──
    describe('COD-187 ?frame=1', () => {
      it('local session: returns the visible-frame capture with source mux-frame, no history/tail processing', async () => {
        harness.ctx._session.terminalBuffer = 'byte history that must NOT appear';
        harness.ctx._session.mode = 'codex';
        const localSpy = vi.fn((_name: string, opts?: { fullHistory?: boolean }) =>
          opts?.fullHistory ? 'FULL_HISTORY' : 'VISIBLE_FRAME_SNAPSHOT'
        );
        (harness.ctx.mux as { captureActivePaneBuffer?: unknown }).captureActivePaneBuffer = localSpy;

        const res = await harness.app.inject({
          method: 'GET',
          url: `/api/sessions/${harness.ctx._sessionId}/terminal?frame=1`,
        });

        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(body.data.source).toBe('mux-frame');
        expect(body.data.terminalBuffer).toBe('VISIBLE_FRAME_SNAPSHOT');
        expect(body.data.truncated).toBe(false);
        expect(localSpy).toHaveBeenCalledWith(harness.ctx._session.muxName);
      });

      it('remote session: uses the remote visibleFrame capture', async () => {
        harness.ctx._session.mode = 'codex';
        (harness.ctx._session as { remote?: unknown }).remote = {
          hostId: 'mac-mini',
          host: '192.168.21.109',
          username: 'saqebakhter',
          remotePath: '/tmp/case',
        };
        const remoteSpy = vi.fn(async () => 'REMOTE_FRAME');
        (harness.ctx.mux as { captureRemotePaneBuffer?: unknown }).captureRemotePaneBuffer = remoteSpy;
        (harness.ctx.mux as { captureActivePaneBuffer?: unknown }).captureActivePaneBuffer = vi.fn(
          () => 'LOCAL_WRAPPER_FRAME'
        );

        const res = await harness.app.inject({
          method: 'GET',
          url: `/api/sessions/${harness.ctx._sessionId}/terminal?frame=1`,
        });

        const body = JSON.parse(res.body);
        expect(body.data.source).toBe('mux-frame');
        expect(body.data.terminalBuffer).toBe('REMOTE_FRAME');
        expect(remoteSpy).toHaveBeenCalledWith(
          (harness.ctx._session as { remote?: unknown }).remote,
          harness.ctx._sessionId,
          harness.ctx._session.muxName,
          { visibleFrame: true, owner: undefined }
        );
      });

      it.each([false, true])('mirror captures local wrapper only when alive (dead=%s)', async (dead) => {
        (harness.ctx._session as { remote?: unknown }).remote = {
          hostId: 'worker',
          host: '192.0.2.1',
          username: 'ubuntu',
          remotePath: '/remote',
        };
        const remote = vi.fn(async () => 'REMOTE_FRAME');
        const local = vi.fn(() => 'LOCAL_FRAME');
        harness.ctx.mux.isPaneDead = vi.fn(async () => dead);
        harness.ctx.mux.captureLivePaneFrame = vi.fn(async () => (dead ? null : 'LOCAL_FRAME'));
        (harness.ctx.mux as { captureRemotePaneBuffer?: unknown }).captureRemotePaneBuffer = remote;
        (harness.ctx.mux as { captureActivePaneBuffer?: unknown }).captureActivePaneBuffer = local;
        const res = await harness.app.inject({
          method: 'GET',
          url: `/api/sessions/${harness.ctx._sessionId}/terminal?frame=1&mirror=1`,
        });
        const data = JSON.parse(res.body).data;
        expect(data.terminalBuffer).toBe(dead ? 'REMOTE_FRAME' : 'LOCAL_FRAME');
        expect(data.source).toBe('mux-frame');
        expect(remote).toHaveBeenCalledTimes(dead ? 1 : 0);
        expect(local).not.toHaveBeenCalled();
        expect(harness.ctx.mux.isPaneDead).not.toHaveBeenCalled();
      });

      it('mirror with empty local wrapper still captures the remote frame', async () => {
        (harness.ctx._session as { remote?: unknown }).remote = {
          hostId: 'worker',
          host: '192.0.2.1',
          username: 'ubuntu',
          remotePath: '/remote',
        };
        harness.ctx.mux.isPaneDead = vi.fn(async () => false);
        const remote = vi.fn(async () => 'REMOTE_FRAME');
        (harness.ctx.mux as { captureRemotePaneBuffer?: unknown }).captureRemotePaneBuffer = remote;
        (harness.ctx.mux as { captureActivePaneBuffer?: unknown }).captureActivePaneBuffer = vi.fn(() => '');
        const res = await harness.app.inject({
          method: 'GET',
          url: `/api/sessions/${harness.ctx._sessionId}/terminal?frame=1&mirror=1`,
        });
        expect(JSON.parse(res.body).data.terminalBuffer).toBe('REMOTE_FRAME');
        expect(remote).toHaveBeenCalledOnce();
      });

      it('COD-441: scopes a remote frame connection to the authenticated viewer', async () => {
        const username = 'frameviewer';
        const cleanup = await useRegularUserHarness(username);
        try {
          harness.ctx._session.owner = username;
          harness.ctx._session.mode = 'codex';
          (harness.ctx._session as { remote?: unknown }).remote = {
            hostId: 'worker',
            host: '192.168.21.109',
            username: 'ubuntu',
            remotePath: '/tmp/case',
          };
          const remoteSpy = vi.fn(async () => 'REMOTE_FRAME');
          (harness.ctx.mux as { captureRemotePaneBuffer?: unknown }).captureRemotePaneBuffer = remoteSpy;

          const res = await harness.app.inject({
            method: 'GET',
            url: `/api/sessions/${harness.ctx._sessionId}/terminal?frame=1`,
          });

          expect(res.statusCode).toBe(200);
          expect(remoteSpy).toHaveBeenCalledWith(
            (harness.ctx._session as { remote?: unknown }).remote,
            harness.ctx._sessionId,
            harness.ctx._session.muxName,
            { visibleFrame: true, owner: username }
          );
        } finally {
          await cleanup();
        }
      });

      it('COD-207: opencode frame request also uses the visible-frame capture path', async () => {
        harness.ctx._session.mode = 'opencode';
        (harness.ctx._session as { remote?: unknown }).remote = {
          hostId: 'mac-mini',
          host: '192.168.21.109',
          username: 'saqebakhter',
          remotePath: '/tmp/case',
        };
        const remoteSpy = vi.fn(async () => 'REMOTE_FRAME');
        (harness.ctx.mux as { captureRemotePaneBuffer?: unknown }).captureRemotePaneBuffer = remoteSpy;
        (harness.ctx.mux as { captureActivePaneBuffer?: unknown }).captureActivePaneBuffer = vi.fn(
          () => 'LOCAL_WRAPPER_FRAME'
        );

        const res = await harness.app.inject({
          method: 'GET',
          url: `/api/sessions/${harness.ctx._sessionId}/terminal?frame=1`,
        });

        const body = JSON.parse(res.body);
        expect(body.data.source).toBe('mux-frame');
        expect(body.data.terminalBuffer).toBe('REMOTE_FRAME');
      });

      it('COD-207: opencode frame fallback remains frame-only with no canonical rewrite source', async () => {
        harness.ctx._session.mode = 'opencode';
        const localFrameSpy = vi.fn(() => 'OPENCODE_VISIBLE_FRAME');
        (harness.ctx.mux as { captureActivePaneBuffer?: unknown }).captureActivePaneBuffer = localFrameSpy;

        const res = await harness.app.inject({
          method: 'GET',
          url: `/api/sessions/${harness.ctx._sessionId}/terminal?frame=1`,
        });

        const body = JSON.parse(res.body);
        expect(body.data.source).toBe('mux-frame');
        expect(body.data.terminalBuffer).toBe('OPENCODE_VISIBLE_FRAME');
        expect(localFrameSpy).toHaveBeenCalledWith(harness.ctx._session.muxName);
      });

      it('remote session: falls back to the local wrapper frame (still mux-frame — the wrapper shows the same screen)', async () => {
        harness.ctx._session.mode = 'codex';
        (harness.ctx._session as { remote?: unknown }).remote = {
          hostId: 'mac-mini',
          host: '192.168.21.109',
          username: 'saqebakhter',
          remotePath: '/tmp/case',
        };
        (harness.ctx.mux as { captureRemotePaneBuffer?: unknown }).captureRemotePaneBuffer = vi.fn(async () => null);
        (harness.ctx.mux as { captureActivePaneBuffer?: unknown }).captureActivePaneBuffer = vi.fn(
          () => 'LOCAL_WRAPPER_FRAME'
        );

        const res = await harness.app.inject({
          method: 'GET',
          url: `/api/sessions/${harness.ctx._sessionId}/terminal?frame=1`,
        });

        const body = JSON.parse(res.body);
        expect(body.data.source).toBe('mux-frame');
        expect(body.data.terminalBuffer).toBe('LOCAL_WRAPPER_FRAME');
      });

      it('no capture available: source history, empty buffer (frontend leaves screen to live repaint)', async () => {
        harness.ctx._session.terminalBuffer = 'byte history that must NOT appear';
        harness.ctx._session.mode = 'codex';
        (harness.ctx.mux as { captureActivePaneBuffer?: unknown }).captureActivePaneBuffer = vi.fn(() => null);

        const res = await harness.app.inject({
          method: 'GET',
          url: `/api/sessions/${harness.ctx._sessionId}/terminal?frame=1`,
        });

        const body = JSON.parse(res.body);
        expect(body.data.source).toBe('history');
        expect(body.data.terminalBuffer).toBe('');
      });

      it('COD-187 lazy history: lines=N bounds the capture and flags partial history', async () => {
        harness.ctx._session.mode = 'codex';
        const manyLines = Array.from({ length: 2000 }, (_, i) => `H${i}`).join('\n');
        const localSpy = vi.fn((_n: string, opts?: { fullHistory?: boolean; lastLines?: number }) =>
          opts?.fullHistory ? manyLines : 'visible'
        );
        (harness.ctx.mux as { captureActivePaneBuffer?: unknown }).captureActivePaneBuffer = localSpy;

        const res = await harness.app.inject({
          method: 'GET',
          url: `/api/sessions/${harness.ctx._sessionId}/terminal?lines=2000`,
        });

        const body = JSON.parse(res.body);
        expect(localSpy).toHaveBeenCalledWith(
          harness.ctx._session.muxName,
          expect.objectContaining({ fullHistory: true, lastLines: 2000 })
        );
        expect(body.data.source).toBe('mux-full-history');
        expect(body.data.historyPartial).toBe(true);
      });

      it('COD-187 lazy history: short capture (fewer lines than requested) is NOT partial', async () => {
        harness.ctx._session.mode = 'codex';
        (harness.ctx.mux as { captureActivePaneBuffer?: unknown }).captureActivePaneBuffer = vi.fn(
          (_n: string, opts?: { fullHistory?: boolean }) => (opts?.fullHistory ? 'only\nfour\nshort\nlines' : 'v')
        );

        const res = await harness.app.inject({
          method: 'GET',
          url: `/api/sessions/${harness.ctx._sessionId}/terminal?lines=2000`,
        });

        const body = JSON.parse(res.body);
        expect(body.data.historyPartial).toBe(false);
      });

      it('COD-187 lazy history: unbounded request never sets historyPartial', async () => {
        harness.ctx._session.mode = 'codex';
        (harness.ctx.mux as { captureActivePaneBuffer?: unknown }).captureActivePaneBuffer = vi.fn(
          (_n: string, opts?: { fullHistory?: boolean }) => (opts?.fullHistory ? 'a\nb\nc' : 'v')
        );
        const res = await harness.app.inject({
          method: 'GET',
          url: `/api/sessions/${harness.ctx._sessionId}/terminal`,
        });
        expect(JSON.parse(res.body).data.historyPartial).toBe(false);
      });

      it('frame wins over tail', async () => {
        harness.ctx._session.terminalBuffer = 'byte history';
        harness.ctx._session.mode = 'codex';
        (harness.ctx.mux as { captureActivePaneBuffer?: unknown }).captureActivePaneBuffer = vi.fn(
          (_n: string, opts?: { fullHistory?: boolean }) => (opts?.fullHistory ? 'FULL' : 'FRAME_ONLY')
        );

        const res = await harness.app.inject({
          method: 'GET',
          url: `/api/sessions/${harness.ctx._sessionId}/terminal?frame=1&tail=65536`,
        });

        const body = JSON.parse(res.body);
        expect(body.data.source).toBe('mux-frame');
        expect(body.data.terminalBuffer).toBe('FRAME_ONLY');
      });
    });

    it('COD-178: codex falls back to raw byte history when capture is unavailable', async () => {
      harness.ctx._session.terminalBuffer = 'accumulated byte history fallback';
      harness.ctx._session.mode = 'codex';
      (harness.ctx.mux as { captureActivePaneBuffer?: unknown }).captureActivePaneBuffer = vi.fn(() => null);

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/terminal`,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.terminalBuffer).toContain('accumulated byte history fallback');
      expect(body.data.source).toBe('history');
    });

    // ── COD-47: full tmux scrollback replay on full page reload ──
    it('full reload (no tail) requests full tmux history and replays boundary markers', async () => {
      // A realistic scrollback-length capture: ~5000 lines, well past one screen.
      const firstLine = 'SCROLLBACK_FIRST_LINE_0001';
      const lastLine = 'SCROLLBACK_LAST_LINE_5000';
      const lines: string[] = [firstLine];
      for (let i = 2; i <= 4999; i++) {
        lines.push(`scrollback line ${String(i).padStart(4, '0')} lorem ipsum payload`);
      }
      lines.push(lastLine);
      const fullHistoryCapture = lines.join('\n');

      harness.ctx._session.mode = 'shell';
      harness.ctx._session.terminalBuffer = '';
      const captureSpy = vi.fn((_name: string, opts?: { fullHistory?: boolean }) =>
        opts?.fullHistory ? fullHistoryCapture : 'only the visible frame'
      );
      (harness.ctx.mux as { captureActivePaneBuffer?: unknown }).captureActivePaneBuffer = captureSpy;

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/terminal`,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      // Full reload asked tmux for the entire scrollback.
      expect(captureSpy).toHaveBeenCalledWith(
        harness.ctx._session.muxName,
        expect.objectContaining({ fullHistory: true })
      );
      // Both boundary markers survived the capture → route pipeline.
      expect(body.data.terminalBuffer).toContain(firstLine);
      expect(body.data.terminalBuffer).toContain(lastLine);
      expect(body.data.source).toBe('mux-full-history');
      expect(typeof body.data.fullSize).toBe('number');
      expect(res.headers['server-timing']).toMatch(/^capture;dur=\d+\.\d, prepare;dur=\d+\.\d, total;dur=\d+\.\d$/);
    });

    it('full reload with a tail (?full=1&tail=) cuts the full capture to its newest bytes, cursor restore intact', async () => {
      // A Shell scroll-to-top asks for exactly this (`_maybeRefetchFullHistory`):
      // tmux's whole scrollback, bounded to the tab-switch tail size. The client
      // relies on all three answers below, so a refactor that dropped the tail on
      // a full capture (an unbounded pull from an ordinary scroll) or cut off the
      // closing cursor move (a caret parked below the prompt) must fail here.
      const tail = 1024 * 1024;
      const oldestMarker = 'BOUNDED_OLDEST_LINE_00001';
      const newestMarker = 'BOUNDED_NEWEST_LINE_40000';
      const rows: string[] = [oldestMarker];
      for (let i = 2; i < 40_000; i++) rows.push(`shell history line ${String(i).padStart(5, '0')} lorem ipsum`);
      rows.push(newestMarker);
      // What formatCursorRestore appends: up from the last row, then the column.
      const cursorRestore = '\x1b[3A\r\x1b[2C';
      const fullHistoryCapture = `${rows.join('\r\n')}${cursorRestore}`;
      expect(fullHistoryCapture.length).toBeGreaterThan(tail);

      harness.ctx._session.mode = 'shell';
      harness.ctx._session.terminalBuffer = '';
      const captureSpy = vi.fn((_name: string, opts?: { fullHistory?: boolean }) =>
        opts?.fullHistory ? fullHistoryCapture : 'only the visible frame'
      );
      (harness.ctx.mux as { captureActivePaneBuffer?: unknown }).captureActivePaneBuffer = captureSpy;

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/terminal?full=1&tail=${tail}`,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      // Still the scrollback, not the visible frame a plain `?tail=` gets.
      expect(captureSpy).toHaveBeenCalledWith(
        harness.ctx._session.muxName,
        expect.objectContaining({ fullHistory: true })
      );
      expect(body.data.source).toBe('mux-full-history');
      // Recoverable, not 'capped': Load full history can still bring the rest back.
      expect(body.data.truncated).toBe(true);
      expect(body.data.truncationReason).toBe('tail');
      expect(body.data.fullSize).toBe(fullHistoryCapture.length);
      expect(body.data.terminalBuffer.length).toBeLessThanOrEqual(tail);
      expect(body.data.terminalBuffer).toContain(newestMarker);
      expect(body.data.terminalBuffer).not.toContain(oldestMarker);
      expect(body.data.terminalBuffer.endsWith(`${newestMarker}${cursorRestore}`)).toBe(true);
    });

    it('`lines=` bounds the history a full capture reads, clamped to the configured limit', async () => {
      // Grid tiles send it (TerminalTile._historyLinesQuery): without it a full
      // capture reads the whole history limit synchronously, and `tail` cuts it
      // only afterwards. Absent or malformed, the limit itself, as before.
      const limit = (await harness.ctx.getTerminalHistoryConfig()).tmuxHistoryLimit;
      harness.ctx._session.mode = 'claude';
      const captureSpy = vi.fn(
        (_name: string, _opts?: { historyLimitLines?: number; lastLines?: number }) => 'captured frame'
      );
      (harness.ctx.mux as { captureActivePaneBuffer?: unknown }).captureActivePaneBuffer = captureSpy;
      const linesFor = async (query: string) => {
        captureSpy.mockClear();
        await harness.app.inject({ method: 'GET', url: `/api/sessions/${harness.ctx._sessionId}/terminal?${query}` });
        const options = captureSpy.mock.calls[0]?.[1];
        return options?.lastLines ?? options?.historyLimitLines;
      };

      expect(await linesFor(`full=1&tail=${1024 * 1024}&lines=10040`)).toBe(10040);
      expect(await linesFor('full=1&lines=1')).toBe(100);
      expect(await linesFor('full=1')).toBe(limit);
      expect(await linesFor(`full=1&lines=${limit + 5}`)).toBe(limit);
      for (const bad of ['0', '-5', 'abc', '1.5', '', '1e4', '9999999999']) {
        expect(await linesFor(`full=1&lines=${bad}`), `lines=${bad}`).toBe(limit);
      }
    });

    it('`lines=` requests bounded full history even without an explicit full flag', async () => {
      harness.ctx._session.mode = 'shell';
      const captureSpy = vi.fn(() => 'bounded pane history');
      (harness.ctx.mux as { captureActivePaneBuffer?: unknown }).captureActivePaneBuffer = captureSpy;
      await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/terminal?tail=${1024 * 1024}&lines=500`,
      });
      expect(captureSpy).toHaveBeenCalledWith(
        harness.ctx._session.muxName,
        expect.objectContaining({ fullHistory: true, lastLines: 500 })
      );
    });

    it('a capture bounded by `lines=` is still a full capture: rows kept, cursor restore last', async () => {
      // Only how much history tmux reads changes. The row-preserving skips key
      // on isFullCapture, and the relative cursor move must still end it.
      const cursorRestore = '\x1b[3A\r\x1b[2C';
      const capture = `\r\n${['first row', 'second row', 'last row'].join('\r\n')}${cursorRestore}`;
      harness.ctx._session.mode = 'claude';
      harness.ctx._session.terminalBuffer = 'byte history that must not be prepended';
      const captureSpy = vi.fn((_name: string, opts?: { fullHistory?: boolean }) =>
        opts?.fullHistory ? capture : 'only the visible frame'
      );
      (harness.ctx.mux as { captureActivePaneBuffer?: unknown }).captureActivePaneBuffer = captureSpy;
      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/terminal?full=1&tail=${1024 * 1024}&lines=40`,
      });
      const body = JSON.parse(res.body);
      expect(body.data.source).toBe('mux-full-history');
      expect(body.data.terminalBuffer.startsWith('\r\nfirst row')).toBe(true);
      expect(body.data.terminalBuffer.endsWith(`last row${cursorRestore}`)).toBe(true);
      expect(body.data.terminalBuffer).not.toContain('byte history');
    });

    it('full reload (?full=1) returns the tmux capture ALONE — byte history is not duplicated', async () => {
      // The full-history capture is the rendered form of everything already in
      // the byte buffer; prepending the byte history would replay the whole
      // conversation twice (\x1b[2J clears the viewport, not xterm scrollback).
      harness.ctx._session.mode = 'claude';
      harness.ctx._session.terminalBuffer = 'BYTE_BUFFER_COPY of the conversation';
      const rendered = 'BYTE_BUFFER_COPY of the conversation\r\nplus older scrollback\r\n› prompt';
      const captureSpy = vi.fn((_name: string, opts?: { fullHistory?: boolean }) =>
        opts?.fullHistory ? rendered : 'visible frame only'
      );
      (harness.ctx.mux as { captureActivePaneBuffer?: unknown }).captureActivePaneBuffer = captureSpy;

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/terminal?full=1`,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.source).toBe('mux-full-history');
      expect(body.data.terminalBuffer).toContain('plus older scrollback');
      // Capture alone: no history+clear-viewport concat, and the byte-buffer
      // content appears exactly once (from the capture, not a duplicate prepend).
      expect(body.data.terminalBuffer).not.toContain('\x1b[H\x1b[2J');
      expect(body.data.terminalBuffer.indexOf('BYTE_BUFFER_COPY')).toBe(
        body.data.terminalBuffer.lastIndexOf('BYTE_BUFFER_COPY')
      );
    });

    it('full reload (?full=1) keeps every leading row so the restored cursor lands on the right line', async () => {
      // The capture ends with an absolute cursor move, so its rows and the pane's
      // rows must line up one for one. Three transforms used to run over it and
      // each could delete a leading line: redraw-bloat stripping, the trim that
      // cuts everything above the Claude banner, and a leading-whitespace strip.
      // Any one of them shifted the frame up and left the caret a row off.
      harness.ctx._session.mode = 'claude';
      harness.ctx._session.terminalBuffer = '';
      // A blank first row, then the banner — the shape a real pane has.
      const rendered = ['', '\x1b[1mClaude Code v2.1.266', 'conversation', '\u276f ', '\x1b[4;3H'].join('\r\n');
      (harness.ctx.mux as { captureActivePaneBuffer?: unknown }).captureActivePaneBuffer = vi.fn(
        (_name: string, opts?: { fullHistory?: boolean }) => (opts?.fullHistory ? rendered : 'visible frame')
      );

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/terminal?full=1`,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.source).toBe('mux-full-history');
      // The blank first row survives, so row N of the reply is row N of the pane.
      expect(body.data.terminalBuffer.startsWith('\r\n')).toBe(true);
      expect(body.data.terminalBuffer.split('\r\n')).toHaveLength(rendered.split('\r\n').length);
    });

    it('full reload (?full=1) still strips the byte history when no capture came back', async () => {
      // The row-preserving skips exist for a rendered pane. When the capture is
      // unavailable the reply IS the byte stream — successive Ink frames, no row
      // alignment to protect — so keying the skips on the query parameter rather
      // than on the capture returned it unstripped, which is the whole reason
      // stripInkRedrawBloat exists. A session with no mux takes this path on
      // every first selection, not just during an outage.
      harness.ctx._session.mode = 'claude';
      // A VPA cluster the stripper will collapse: >= 10 sequences, spanning the
      // 32KB minimum, with real content after it.
      const frame = '\x1b[12d' + 'spinner frame '.repeat(240);
      harness.ctx._session.terminalBuffer = frame.repeat(20) + 'REAL CONTENT AFTER THE BLOAT';
      (harness.ctx.mux as { captureActivePaneBuffer?: unknown }).captureActivePaneBuffer = vi.fn(() => null);

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/terminal?full=1`,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.source).toBe('history');
      expect(body.data.terminalBuffer).toContain('REAL CONTENT AFTER THE BLOAT');
      // Stripped, not passed through whole.
      expect(body.data.terminalBuffer.length).toBeLessThan(harness.ctx._session.terminalBuffer.length);
    });

    it('full reload (?full=1) keeps the byte history when the capture is empty', async () => {
      // Pins the contract the capture side relies on: an empty capture means
      // "nothing to replay" and the byte history survives. capturePaneBuffer
      // returns '' for an all-blank pane precisely to reach this branch, since
      // retaining trailing blank rows and appending a cursor move would
      // otherwise make a blank screen non-empty and replace the history with it.
      // (The blank-pane decision itself is unit-tested on hasVisibleContent —
      // capturePaneBuffer short-circuits under IS_TEST_MODE and cannot run here.)
      harness.ctx._session.mode = 'claude';
      harness.ctx._session.terminalBuffer = 'a real conversation worth keeping';
      (harness.ctx.mux as { captureActivePaneBuffer?: unknown }).captureActivePaneBuffer = vi.fn(
        (_name: string, opts?: { fullHistory?: boolean }) => (opts?.fullHistory ? '' : 'visible frame')
      );

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/terminal?full=1`,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.source).toBe('history');
      expect(body.data.terminalBuffer).toContain('a real conversation worth keeping');
    });

    it('full reload (?full=1) falls back to the byte history when the capture is unavailable', async () => {
      harness.ctx._session.mode = 'claude';
      harness.ctx._session.terminalBuffer = 'byte history survives';
      (harness.ctx.mux as { captureActivePaneBuffer?: unknown }).captureActivePaneBuffer = vi.fn(() => null);

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/terminal?full=1`,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.source).toBe('history');
      expect(body.data.terminalBuffer).toContain('byte history survives');
    });

    it('full reload forwards the configured history-line limit and byte cap to the capture', async () => {
      harness.ctx.getTerminalHistoryConfig = vi.fn(async () => ({
        terminalScrollbackLines: 60_000,
        tmuxHistoryLimit: 123_456,
        terminalBufferMaxBytes: 5 * 1024 * 1024,
        terminalBufferTrimBytes: 4 * 1024 * 1024,
      }));
      const captureSpy = vi.fn(() => 'full scrollback');
      (harness.ctx.mux as { captureActivePaneBuffer?: unknown }).captureActivePaneBuffer = captureSpy;

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/terminal?full=1`,
      });

      expect(res.statusCode).toBe(200);
      expect(captureSpy).toHaveBeenCalledWith(harness.ctx._session.muxName, {
        fullHistory: true,
        historyLimitLines: 123_456,
        maxCaptureBytes: 5 * 1024 * 1024,
      });
    });

    it('tab switch (with tail) uses the visible frame, not full history', async () => {
      // COD-178 moved codex/gemini to full-capture-only replay; the cheap
      // visible-frame tail capture still applies to shell (and claude) modes.
      harness.ctx._session.mode = 'shell';
      harness.ctx._session.terminalBuffer = 'accumulated history';
      const captureSpy = vi.fn((_name: string, opts?: { fullHistory?: boolean }) =>
        opts?.fullHistory ? 'FULL_HISTORY_SHOULD_NOT_APPEAR' : 'visible frame only\n› prompt'
      );
      (harness.ctx.mux as { captureActivePaneBuffer?: unknown }).captureActivePaneBuffer = captureSpy;

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/terminal?tail=65536`,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      // Tail/tab-switch must NOT request fullHistory (undefined opts).
      expect(captureSpy).toHaveBeenCalledWith(
        harness.ctx._session.muxName,
        expect.not.objectContaining({ fullHistory: true })
      );
      expect(body.data.terminalBuffer).toContain('visible frame only');
      expect(body.data.terminalBuffer).not.toContain('FULL_HISTORY_SHOULD_NOT_APPEAR');
      expect(body.data.source).toBe('mux-visible');
    });

    it('caps huge full-history at the configured terminal buffer limit and marks truncated', async () => {
      // Shrink the cap so the test can exceed it without allocating 32MB.
      harness.ctx.getTerminalHistoryConfig = vi.fn(async () => ({
        terminalScrollbackLines: 100_000,
        tmuxHistoryLimit: 100_000,
        terminalBufferMaxBytes: 4096,
        terminalBufferTrimBytes: 4096,
      }));
      harness.ctx._session.mode = 'shell';
      harness.ctx._session.terminalBuffer = '';
      const oldestMarker = 'OLDEST_EVICTED_MARKER';
      const newestMarker = 'NEWEST_KEPT_MARKER';
      const filler = Array.from({ length: 400 }, (_, i) => `line ${i} ${'x'.repeat(30)}`).join('\n');
      const huge = `${oldestMarker}\n${filler}\n${newestMarker}`;
      (harness.ctx.mux as { captureActivePaneBuffer?: unknown }).captureActivePaneBuffer = vi.fn(
        (_name: string, opts?: { fullHistory?: boolean }) => (opts?.fullHistory ? huge : 'visible')
      );

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/terminal`,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.truncated).toBe(true);
      expect(body.data.fullSize).toBeGreaterThan(4096);
      expect(body.data.terminalBuffer.length).toBeLessThanOrEqual(4096);
      // Cap keeps the most RECENT bytes: newest marker survives, oldest is dropped.
      expect(body.data.terminalBuffer).toContain(newestMarker);
      expect(body.data.terminalBuffer).not.toContain(oldestMarker);
    });

    it('treats stale Codex scrollback config as TUI replay', async () => {
      // A stale renderMode:'scrollback' in codexConfig must NOT switch codex
      // back to append-style history replay — capture-only (COD-178) applies.
      harness.ctx._session.terminalBuffer = 'hello world\nlater accumulated history';
      harness.ctx._session.mode = 'codex';
      harness.ctx._session.codexConfig = { renderMode: 'scrollback' } as any;
      (harness.ctx.mux as { captureActivePaneBuffer?: unknown }).captureActivePaneBuffer = vi.fn(
        () => 'full capture scrollback\n› current prompt'
      );

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/terminal`,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.terminalBuffer).toContain('full capture scrollback');
      expect(body.data.terminalBuffer).not.toContain('hello world');
      expect(body.data.terminalBuffer).not.toContain('\x1b[H\x1b[2J');
      expect(harness.ctx.mux.captureActivePaneBuffer).toHaveBeenCalledWith(
        harness.ctx._session.muxName,
        expect.objectContaining({
          fullHistory: true,
        })
      );
    });

    it('preserves one-time OAuth authorization URLs in Codex TUI replay history', async () => {
      // Everything codex prints lands in the tmux scrollback, so the full
      // capture (the only thing codex replay ships since COD-178) carries the
      // one-time OAuth URL the user still needs to click.
      const authUrl =
        'https://auth.atlassian.com/authorize?response_type=code&client_id=abc&redirect_uri=http%3A%2F%2F127.0.0.1%3A35547%2Fcallback%2Fxyz';
      harness.ctx._session.terminalBuffer = 'stale codex redraw frames';
      harness.ctx._session.mode = 'codex';
      (harness.ctx.mux as { captureActivePaneBuffer?: unknown }).captureActivePaneBuffer = vi.fn(
        () =>
          'Authorize `atlassian` by opening this URL in your browser:\n' +
          authUrl +
          '\n(Browser launch failed; please copy the URL above manually.)\n' +
          '› current prompt'
      );

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/terminal`,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.terminalBuffer).toContain(authUrl);
      expect(body.data.terminalBuffer).toContain('› current prompt');
      expect(body.data.terminalBuffer).not.toContain('stale codex redraw frames');
    });

    it('preserves incidental OAuth URL mentions as ordinary Codex TUI history', async () => {
      const authUrl =
        'https://auth.atlassian.com/authorize?response_type=code&client_id=abc&redirect_uri=http%3A%2F%2F127.0.0.1%3A35547%2Fcallback%2Fxyz';
      harness.ctx._session.terminalBuffer = 'stale codex redraw frames';
      harness.ctx._session.mode = 'codex';
      (harness.ctx.mux as { captureActivePaneBuffer?: unknown }).captureActivePaneBuffer = vi.fn(
        () =>
          'Root cause: URLs like ' +
          authUrl +
          ' could be present in history but missing from browser-rendered terminal replay.\n' +
          '› current prompt'
      );

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/terminal`,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.terminalBuffer).toContain(authUrl);
      expect(body.data.terminalBuffer).toContain('› current prompt');
    });

    it('preserves accumulated history before a live mux pane snapshot for non-Codex sessions', async () => {
      harness.ctx._session.terminalBuffer = 'hello world\nlater accumulated history';
      harness.ctx._session.mode = 'claude';
      (harness.ctx.mux as { captureActivePaneBuffer?: unknown }).captureActivePaneBuffer = vi.fn(
        () => 'visible tmux pane only\n› current prompt'
      );

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/terminal`,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.terminalBuffer).toContain('hello world');
      expect(body.data.terminalBuffer).toContain('later accumulated history');
      expect(body.data.terminalBuffer).toContain('visible tmux pane only');
      expect(body.data.terminalBuffer).toContain('\x1b[H\x1b[2Jvisible tmux pane only');
      expect(body.data.terminalBuffer.indexOf('hello world')).toBeLessThan(
        body.data.terminalBuffer.indexOf('visible tmux pane only')
      );
      expect(harness.ctx.mux.captureActivePaneBuffer).toHaveBeenCalledWith(
        harness.ctx._session.muxName,
        expect.objectContaining({ fullHistory: true })
      );
    });

    it('uses live mux pane capture only when the accumulated buffer is empty', async () => {
      harness.ctx._session.terminalBuffer = '';
      harness.ctx._session.mode = 'codex';
      (harness.ctx.mux as { captureActivePaneBuffer?: unknown }).captureActivePaneBuffer = vi.fn(
        () => 'visible restored tmux pane\n› current prompt'
      );

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/terminal`,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.terminalBuffer).toContain('visible restored tmux pane');
      expect(body.data.terminalBuffer).toContain('› current prompt');
      expect(harness.ctx.mux.captureActivePaneBuffer).toHaveBeenCalledWith(
        harness.ctx._session.muxName,
        expect.objectContaining({ fullHistory: true })
      );
    });

    it('returns error for unknown session', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/sessions/nonexistent/terminal',
      });
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });

    it('prepends the live tmux pane buffer (cleared) before the byte history', async () => {
      harness.ctx._session.terminalBuffer = 'history-bytes';
      harness.ctx.mux.captureActivePaneBuffer = vi.fn(() => 'LIVE-PANE-FRAME');

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/terminal`,
      });
      expect(res.statusCode).toBe(200);
      const buf = JSON.parse(res.body).data.terminalBuffer as string;
      // history, then a viewport clear, then the live pane frame
      expect(buf).toContain('history-bytes');
      expect(buf).toContain('\x1b[H\x1b[2J');
      expect(buf).toContain('LIVE-PANE-FRAME');
      expect(buf.indexOf('history-bytes')).toBeLessThan(buf.indexOf('LIVE-PANE-FRAME'));
      expect(harness.ctx.mux.captureActivePaneBuffer).toHaveBeenCalledWith(
        harness.ctx._session.muxName,
        expect.objectContaining({ fullHistory: true })
      );
    });

    it('falls back to the byte history when no live pane buffer is available', async () => {
      harness.ctx._session.terminalBuffer = 'history-only';
      // Empty string (the test-mode return) and null both mean "no live frame".
      harness.ctx.mux.captureActivePaneBuffer = vi.fn(() => '');

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/terminal`,
      });
      expect(res.statusCode).toBe(200);
      const buf = JSON.parse(res.body).data.terminalBuffer as string;
      expect(buf).toContain('history-only');
      expect(buf).not.toContain('\x1b[H\x1b[2J');
    });
  });

  // ========== POST /api/sessions/:id/run ==========

  describe('POST /api/sessions/:id/run', () => {
    it('runs prompt on session', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/run`,
        payload: { prompt: 'do something' },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
    });

    it('rejects empty prompt', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/run`,
        payload: { prompt: '' },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });

    it('returns error for unknown session', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/sessions/nonexistent/run',
        payload: { prompt: 'test' },
      });
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });

    it('returns error if session is busy', async () => {
      harness.ctx._session.isBusy.mockReturnValue(true);
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/run`,
        payload: { prompt: 'test' },
      });
      expect(res.statusCode).toBe(409);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });
  });

  // ========== POST /api/sessions/:id/interactive ==========

  describe('POST /api/sessions/:id/interactive', () => {
    it('starts interactive mode', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/interactive`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(harness.ctx._session.startInteractive).toHaveBeenCalled();
    });

    it('returns error for unknown session', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/sessions/nonexistent/interactive',
      });
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });

    // Ark0N/Codeman#446: starting a command in the pane retracts `paneExit`, and
    // the pane-exit watcher cannot write that retraction for us — its next tick
    // finds the field already cleared, reports no change and persists nothing.
    // Broadcasting without persisting leaves state.json saying the agent exited.
    it('persists the session, not just broadcasts it', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/interactive`,
      });
      expect(res.statusCode).toBe(200);
      expect(harness.ctx.persistSessionState).toHaveBeenCalledWith(harness.ctx._session);
    });

    it('returns error if session is busy', async () => {
      harness.ctx._session.isBusy.mockReturnValue(true);
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/interactive`,
      });
      expect(res.statusCode).toBe(409);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });

    // COD-118: this endpoint is ALSO the frontend's automatic re-attach path, so it
    // must never clear a tripped PTY-exit breaker unless the request explicitly asks.
    it('does NOT clear the PTY-exit breaker on an automatic re-attach (no body)', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/interactive`,
      });
      expect(res.statusCode).toBe(200);
      expect(harness.ctx._session.resetRespawnBreaker).not.toHaveBeenCalled();
      expect(harness.ctx._session.startInteractive).toHaveBeenCalled();
    });

    it('clears the PTY-exit breaker when the explicit restart flag is sent (COD-118)', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/interactive`,
        payload: { clearBreaker: true },
      });
      expect(res.statusCode).toBe(200);
      expect(harness.ctx._session.resetRespawnBreaker).toHaveBeenCalledTimes(1);
      expect(harness.ctx._session.startInteractive).toHaveBeenCalled();
    });

    it('rejects a non-boolean clearBreaker flag', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/interactive`,
        payload: { clearBreaker: 'yes' },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.errorCode).toBe(ApiErrorCode.INVALID_INPUT);
      expect(harness.ctx._session.resetRespawnBreaker).not.toHaveBeenCalled();
      expect(harness.ctx._session.startInteractive).not.toHaveBeenCalled();
    });

    // COD-118: the wiring exit handler detaches ALL session listeners on PTY exit;
    // re-attach must restore them or later trips/output go unobserved.
    it('re-runs session listener wiring before starting', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/interactive`,
      });
      expect(res.statusCode).toBe(200);
      expect(harness.ctx.setupSessionListeners).toHaveBeenCalledWith(harness.ctx._session);
    });
  });

  // ========== POST /api/sessions/:id/shell ==========

  describe('POST /api/sessions/:id/shell', () => {
    it('starts shell mode', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/shell`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(harness.ctx._session.startShell).toHaveBeenCalled();
      // COD-118: re-attach restores listener wiring detached by a prior PTY exit.
      expect(harness.ctx.setupSessionListeners).toHaveBeenCalledWith(harness.ctx._session);
    });

    // Same reason as /interactive above (Ark0N/Codeman#446).
    it('persists the session, not just broadcasts it', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/shell`,
      });
      expect(res.statusCode).toBe(200);
      expect(harness.ctx.persistSessionState).toHaveBeenCalledWith(harness.ctx._session);
    });

    it('returns error if session is busy', async () => {
      harness.ctx._session.isBusy.mockReturnValue(true);
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/shell`,
      });
      expect(res.statusCode).toBe(409);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });
  });

  // ========== POST /api/sessions/:id/park (COD-124) ==========

  describe('POST /api/sessions/:id/park', () => {
    it('parks an active session', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/park`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(harness.ctx._session.park).toHaveBeenCalled();
      expect(harness.ctx.broadcast).toHaveBeenCalledWith('session:parked', expect.anything());
      expect(harness.ctx.broadcast).toHaveBeenCalledWith('session:updated', expect.anything());
    });

    it('returns error for unknown session', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/sessions/nonexistent/park',
      });
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });

    it('is idempotent when the session is already parked', async () => {
      harness.ctx._session.status = 'parked';
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/park`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      // Already parked — park() should NOT be invoked again.
      expect(harness.ctx._session.park).not.toHaveBeenCalled();
    });
  });

  // ========== POST /api/sessions/:id/resume (COD-124) ==========

  describe('POST /api/sessions/:id/resume', () => {
    it('resumes a parked session', async () => {
      harness.ctx._session.status = 'parked';
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/resume`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      // COD-118-style requirement: listener wiring must be re-attached before
      // startInteractive() is called, since park() detaches listeners via PTY exit.
      expect(harness.ctx.setupSessionListeners).toHaveBeenCalledWith(harness.ctx._session);
      expect(harness.ctx._session.startInteractive).toHaveBeenCalled();
      expect(harness.ctx.broadcast).toHaveBeenCalledWith('session:resumed', expect.anything());
      expect(harness.ctx.broadcast).toHaveBeenCalledWith('session:updated', expect.anything());
    });

    it('returns error for unknown session', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/sessions/nonexistent/resume',
      });
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });

    it('rejects resume when the session is not parked', async () => {
      // Default mock status is 'idle', not 'parked'.
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/resume`,
      });
      expect(res.statusCode).toBe(409);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.errorCode).toBe(ApiErrorCode.CONFLICT);
      expect(harness.ctx._session.startInteractive).not.toHaveBeenCalled();
    });

    // Non-Claude CLIs (codex/opencode/gemini/shell) get a best-effort relaunch
    // in the same workingDir with NO conversation restore — startInteractive()
    // is still called (it's the same relaunch path), but no --resume semantics
    // are claimed or asserted for these modes.
    it('best-effort relaunches a parked non-claude-mode session (no conversation restore claimed)', async () => {
      harness.ctx._session.status = 'parked';
      harness.ctx._session.mode = 'codex';
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/resume`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(harness.ctx._session.startInteractive).toHaveBeenCalled();
    });
  });

  // ========== GET /api/sessions/:id/output ==========

  describe('GET /api/sessions/:id/output', () => {
    it('returns session output data', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/output`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data).toHaveProperty('textOutput');
      expect(body.data).toHaveProperty('messages');
      expect(body.data).toHaveProperty('errorBuffer');
    });

    it('returns error for unknown session', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/sessions/nonexistent/output',
      });
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });
  });

  // ========== GET /api/sessions/:id/ralph-state ==========

  describe('GET /api/sessions/:id/ralph-state', () => {
    it('returns ralph state data', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/ralph-state`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data).toHaveProperty('loop');
      expect(body.data).toHaveProperty('todos');
      expect(body.data).toHaveProperty('todoStats');
    });
  });

  // ========== GET /api/sessions/:id/active-tools ==========

  describe('GET /api/sessions/:id/active-tools', () => {
    it('returns active tools', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/active-tools`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data).toHaveProperty('tools');
    });
  });

  // ========== POST /api/logout ==========

  describe('POST /api/logout', () => {
    it('returns success', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/logout',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
    });
  });

  // ========== GET /api/history/sessions ==========

  describe('GET /api/history/sessions', () => {
    it('returns sessions array', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/history/sessions',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data).toHaveProperty('sessions');
      expect(Array.isArray(body.data.sessions)).toBe(true);
    });

    it('never exposes Claude history from outside the sandboxed test HOME', async () => {
      // Previously asserted an exactly-empty list, which a `ctx.testMode`
      // short-circuit in the route guaranteed. That short-circuit is gone: the
      // history-quality tests below need the scan to actually run, and sibling
      // tests legitimately write transcripts into the temp HOME, so "empty" is
      // no longer the invariant. What still must hold — and is the whole point —
      // is that nothing outside test/setup.ts's per-file temp HOME can appear.
      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/history/sessions',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      const home = process.env.HOME as string;
      expect(home).toBeTruthy();
      for (const session of body.data.sessions) {
        expect(session.workingDir.startsWith(home)).toBe(true);
      }
    });

    it('sessions have required fields', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/history/sessions',
      });
      const body = JSON.parse(res.body);
      for (const session of body.data.sessions) {
        expect(session).toHaveProperty('sessionId');
        expect(session).toHaveProperty('workingDir');
        expect(session).toHaveProperty('projectKey');
        expect(session).toHaveProperty('sizeBytes');
        expect(session).toHaveProperty('lastModified');
        // sessionId must be a valid UUID
        expect(session.sessionId).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
      }
    });

    it('sessions are sorted by lastModified descending', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/history/sessions',
      });
      const body = JSON.parse(res.body);
      const dates = body.data.sessions.map((s: { lastModified: string }) => new Date(s.lastModified).getTime());
      for (let i = 1; i < dates.length; i++) {
        expect(dates[i - 1]).toBeGreaterThanOrEqual(dates[i]);
      }
    });

    it('returns at most 50 sessions', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/history/sessions',
      });
      const body = JSON.parse(res.body);
      expect(body.data.sessions.length).toBeLessThanOrEqual(50);
    });

    it('decodes a dotdir working directory (e.g. ~/.codeman) instead of falling back to $HOME', async () => {
      // Claude Code's project-key encoding maps both '/' and '.' to '-', so
      // "/home/x/.dotcase" and "/home/x/dotcase" collapse to the same-looking
      // dash run except for a doubled dash. decodeProjectKey() must still
      // recover the real (dotdir) path rather than silently falling back to
      // bare $HOME (COD bug: 2026-08-01, ~/.codeman resumed sessions got
      // workingDir "/home/timkjr" instead of "/home/timkjr/.codeman").
      const home = process.env.HOME as string;
      const realDir = join(home, '.dotcase');
      await mkdir(realDir, { recursive: true });

      const projectKey = realDir.replace(/\//g, '-').replace(/\./g, '-');
      const projDir = join(home, '.claude', 'projects', projectKey);
      await mkdir(projDir, { recursive: true });

      const sessionId = '12345678-1234-1234-1234-123456789012';
      const transcriptLine = JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello world' } }) + '\n';
      // scanProjectDir skips files under 4000 bytes.
      const padding = '#'.repeat(4200 - transcriptLine.length);
      await writeFile(join(projDir, `${sessionId}.jsonl`), transcriptLine + padding);

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/history/sessions?projectKey=${projectKey}`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      const row = body.data.sessions.find((s: { sessionId: string }) => s.sessionId === sessionId);
      expect(row).toBeDefined();
      expect(row.workingDir).toBe(realDir);
      expect(row.workingDir).not.toBe(home);
    });

    it('prefers the dotdir over a same-named non-dot sibling, and never emits a "//" path', async () => {
      // A doubled dash also lets the decoder read the empty split segment as a
      // directory NAME. `isDir(current + '/' + '')` stats `current + '/'`, which
      // always succeeds, so `~/.sib` + `~/sib` both existing used to resolve to
      // "/home/x//sib": the wrong directory, spelled with a double slash that
      // then fails every string comparison against session.workingDir. The empty
      // candidate is never a real path component, so it is skipped outright,
      // which is also what lets the dotdir branch below it run at all.
      const home = process.env.HOME as string;
      const dotDir = join(home, '.sib');
      await mkdir(dotDir, { recursive: true });
      await mkdir(join(home, 'sib'), { recursive: true });

      const projectKey = dotDir.replace(/\//g, '-').replace(/\./g, '-');
      const projDir = join(home, '.claude', 'projects', projectKey);
      await mkdir(projDir, { recursive: true });

      const sessionId = '22222222-2222-2222-2222-222222222222';
      const line = JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello world' } }) + '\n';
      await writeFile(join(projDir, `${sessionId}.jsonl`), line + '#'.repeat(4200 - line.length));

      const res = await harness.app.inject({ method: 'GET', url: `/api/history/sessions?projectKey=${projectKey}` });
      expect(res.statusCode).toBe(200);
      const row = JSON.parse(res.body).data.sessions.find((s: { sessionId: string }) => s.sessionId === sessionId);
      expect(row).toBeDefined();
      expect(row.workingDir).toBe(dotDir);
      expect(row.workingDir).not.toContain('//');
    });

    it('excludes non-interactive (SDK-driven) transcripts from the history list', async () => {
      // CI review bots and other automated tools write transcripts into the same
      // ~/.claude/projects tree as interactive sessions (entrypoint "sdk-py" etc.)
      // but were never something a user can resume into — no PTY, no running
      // process. They cluttered Past Sessions as blank rows or identical
      // boilerplate ("Review this change for security vulnerabilities...").
      const home = process.env.HOME as string;
      const projPath = join(home, '.claude', 'projects', 'proj-entrypoint-test');
      await mkdir(projPath, { recursive: true });

      const cliId = '33333333-3333-3333-3333-333333333333';
      const sdkId = '44444444-4444-4444-4444-444444444444';
      const noEntrypointId = '55555555-5555-5555-5555-555555555555';

      const cliLine =
        JSON.stringify({ type: 'user', entrypoint: 'cli', message: { role: 'user', content: 'a real question' } }) +
        '\n';
      const sdkLine =
        JSON.stringify({
          type: 'user',
          entrypoint: 'sdk-py',
          message: { role: 'user', content: 'Review this change for security vulnerabilities.' },
        }) + '\n';
      // Older transcripts predate the entrypoint field entirely — must still show.
      const noEntrypointLine =
        JSON.stringify({ type: 'user', message: { role: 'user', content: 'a pre-entrypoint session' } }) + '\n';

      await writeFile(join(projPath, `${cliId}.jsonl`), cliLine + '#'.repeat(4200 - cliLine.length));
      await writeFile(join(projPath, `${sdkId}.jsonl`), sdkLine + '#'.repeat(4200 - sdkLine.length));
      await writeFile(
        join(projPath, `${noEntrypointId}.jsonl`),
        noEntrypointLine + '#'.repeat(4200 - noEntrypointLine.length)
      );

      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/history/sessions?projectKey=proj-entrypoint-test',
      });
      expect(res.statusCode).toBe(200);
      const ids = JSON.parse(res.body).data.sessions.map((s: { sessionId: string }) => s.sessionId);
      expect(ids).toContain(cliId);
      expect(ids).toContain(noEntrypointId);
      expect(ids).not.toContain(sdkId);
    });

    it('ignores a bookkeeping line that happens to mention "entrypoint" outside a real message record', async () => {
      // Scanning must anchor on "type":"user"/"assistant" lines specifically,
      // not any line that happens to contain the substring "entrypoint".
      const home = process.env.HOME as string;
      const projPath = join(home, '.claude', 'projects', 'proj-entrypoint-bookkeeping-test');
      await mkdir(projPath, { recursive: true });

      const sessionId = '77777777-7777-7777-7777-777777777777';
      const bookkeepingLine = JSON.stringify({ type: 'mode', mode: 'normal', entrypoint: 'sdk-py' }) + '\n';
      const realLine =
        JSON.stringify({ type: 'user', entrypoint: 'cli', message: { role: 'user', content: 'a real message' } }) +
        '\n';

      // scanProjectDir skips files under 4000 bytes.
      const body = bookkeepingLine + realLine;
      await writeFile(join(projPath, `${sessionId}.jsonl`), body + '#'.repeat(4200 - body.length));

      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/history/sessions?projectKey=proj-entrypoint-bookkeeping-test',
      });
      expect(res.statusCode).toBe(200);
      const ids = JSON.parse(res.body).data.sessions.map((s: { sessionId: string }) => s.sessionId);
      expect(ids).toContain(sessionId);
    });

    it('shows a session with ANY interactive (cli) message, even if an earlier message was automated', async () => {
      // "First field wins" would have misattributed this: an old transcript
      // whose true first message predates the entrypoint field, later resumed
      // under something automated (entrypoint: 'sdk-py' on message 2), then
      // continued interactively by a real person (entrypoint: 'cli' on message
      // 3). Stopping at the first entrypoint-bearing line found ('sdk-py')
      // would wrongly exclude a session a human genuinely used. One real
      // interactive message anywhere is enough to keep it visible.
      const home = process.env.HOME as string;
      const projPath = join(home, '.claude', 'projects', 'proj-entrypoint-any-cli-test');
      await mkdir(projPath, { recursive: true });

      const sessionId = '99999999-9999-9999-9999-999999999999';
      const firstLine =
        JSON.stringify({ type: 'user', message: { role: 'user', content: 'pre-entrypoint-field message' } }) + '\n';
      const automatedLine =
        JSON.stringify({
          type: 'user',
          entrypoint: 'sdk-py',
          message: { role: 'user', content: 'an automated follow-up' },
        }) + '\n';
      const interactiveLine =
        JSON.stringify({
          type: 'user',
          entrypoint: 'cli',
          message: { role: 'user', content: 'a real person continued this' },
        }) + '\n';

      const body = firstLine + automatedLine + interactiveLine;
      await writeFile(join(projPath, `${sessionId}.jsonl`), body + '#'.repeat(4200 - body.length));

      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/history/sessions?projectKey=proj-entrypoint-any-cli-test',
      });
      expect(res.statusCode).toBe(200);
      const ids = JSON.parse(res.body).data.sessions.map((s: { sessionId: string }) => s.sessionId);
      expect(ids).toContain(sessionId);
    });

    it('still excludes a session where every entrypoint-bearing message is automated', async () => {
      // Mirror of the previous test with no 'cli' message anywhere — proves the
      // "any cli wins" fix isn't just failing open unconditionally.
      const home = process.env.HOME as string;
      const projPath = join(home, '.claude', 'projects', 'proj-entrypoint-all-automated-test');
      await mkdir(projPath, { recursive: true });

      const sessionId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
      const firstLine =
        JSON.stringify({
          type: 'user',
          entrypoint: 'sdk-py',
          message: { role: 'user', content: 'Review this change for security vulnerabilities.' },
        }) + '\n';
      const secondLine =
        JSON.stringify({
          type: 'assistant',
          entrypoint: 'sdk-py',
          message: { role: 'assistant', content: [{ type: 'text', text: 'Looking at the diff...' }] },
        }) + '\n';

      const body = firstLine + secondLine;
      await writeFile(join(projPath, `${sessionId}.jsonl`), body + '#'.repeat(4200 - body.length));

      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/history/sessions?projectKey=proj-entrypoint-all-automated-test',
      });
      expect(res.statusCode).toBe(200);
      const ids = JSON.parse(res.body).data.sessions.map((s: { sessionId: string }) => s.sessionId);
      expect(ids).not.toContain(sessionId);
    });

    it('keeps a session whose entrypoint is an unrecognized non-SDK value (fail open)', async () => {
      // The exclusion is a blocklist on the SDK shape, NOT an allowlist on 'cli'.
      // An allowlist fails CLOSED on any value Claude Code has not shipped yet:
      // the day it stamps a new interactive entrypoint, nothing matches 'cli' and
      // the entire Past Sessions list silently goes blank. Excluding only what we
      // positively recognize as automated fails open instead — a few noisy rows,
      // not a dead feature.
      const home = process.env.HOME as string;
      const projPath = join(home, '.claude', 'projects', 'proj-entrypoint-unknown-test');
      await mkdir(projPath, { recursive: true });

      const sessionId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
      const line =
        JSON.stringify({
          type: 'user',
          entrypoint: 'cli-next',
          message: { role: 'user', content: 'a question from a future interactive host' },
        }) + '\n';
      await writeFile(join(projPath, `${sessionId}.jsonl`), line + '#'.repeat(4200 - line.length));

      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/history/sessions?projectKey=proj-entrypoint-unknown-test',
      });
      expect(res.statusCode).toBe(200);
      const ids = JSON.parse(res.body).data.sessions.map((s: { sessionId: string }) => s.sessionId);
      expect(ids).toContain(sessionId);
    });

    it('finds the real first prompt past a large run of pre-message bookkeeping lines', async () => {
      // A session restarted many times over a long conversation accumulates a batch
      // of small bookkeeping lines (mode/permission-mode/last-prompt/queue-operation)
      // per restart, ahead of the real first message. With enough restarts these can
      // push the genuine first prompt past a 16KB head-read window even though the
      // message itself is tiny — the row showed up blank despite having real content.
      const home = process.env.HOME as string;
      const projPath = join(home, '.claude', 'projects', 'proj-bookkeeping-test');
      await mkdir(projPath, { recursive: true });

      const sessionId = '66666666-6666-6666-6666-666666666666';
      const bookkeepingLine = JSON.stringify({ type: 'mode', mode: 'normal', sessionId }) + '\n';
      // > 16KB (the old head-read size) but well under 128KB (the new one).
      const prefix = bookkeepingLine.repeat(Math.ceil(20000 / bookkeepingLine.length));
      const realLine =
        JSON.stringify({
          type: 'user',
          entrypoint: 'cli',
          message: { role: 'user', content: 'the real first message' },
        }) + '\n';
      expect(prefix.length).toBeGreaterThan(16384);

      await writeFile(join(projPath, `${sessionId}.jsonl`), prefix + realLine);

      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/history/sessions?projectKey=proj-bookkeeping-test',
      });
      expect(res.statusCode).toBe(200);
      const row = JSON.parse(res.body).data.sessions.find((s: { sessionId: string }) => s.sessionId === sessionId);
      expect(row).toBeDefined();
      expect(row.firstPrompt).toBe('the real first message');
    });

    it('still falls back to the tail read when bookkeeping alone exceeds the new 128KB head window', async () => {
      // Raising the head buffer to 128KB helps most restart-heavy sessions, but an
      // even more extreme case (many more restarts) can still exceed it. This
      // proves the tail-read fallback itself is intact after the threshold
      // rewrite (`fileStat.size > headBuf.length` replacing the old hardcoded
      // 16384/65536) — the fallback's own logic, not the exact threshold value,
      // is what could have silently broken (e.g. a copy-paste slip that dropped
      // the `> headBuf.length` check entirely). The real message sits near the
      // end of the file, well inside the 32KB tail window, so a working fallback
      // finds it; a broken one leaves the row blank exactly like the bug this
      // whole fix addresses.
      const home = process.env.HOME as string;
      const projPath = join(home, '.claude', 'projects', 'proj-tail-fallback-test');
      await mkdir(projPath, { recursive: true });

      const sessionId = '88888888-8888-8888-8888-888888888888';
      const bookkeepingLine = JSON.stringify({ type: 'mode', mode: 'normal', sessionId }) + '\n';
      // Comfortably past the new 128KB head window (was 16KB), so the head read
      // never reaches a single "type":"user"/"assistant"/"summary" line.
      const prefix = bookkeepingLine.repeat(Math.ceil(140000 / bookkeepingLine.length));
      const realLine =
        JSON.stringify({
          type: 'user',
          entrypoint: 'cli',
          message: { role: 'user', content: 'found via tail fallback' },
        }) + '\n';
      expect(prefix.length).toBeGreaterThan(131072);

      await writeFile(join(projPath, `${sessionId}.jsonl`), prefix + realLine);

      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/history/sessions?projectKey=proj-tail-fallback-test',
      });
      expect(res.statusCode).toBe(200);
      const row = JSON.parse(res.body).data.sessions.find((s: { sessionId: string }) => s.sessionId === sessionId);
      expect(row).toBeDefined();
      expect(row.firstPrompt).toBe('found via tail fallback');
    });
  });

  // ========== POST /api/sessions (with resumeSessionId) ==========

  describe('POST /api/sessions with resumeSessionId', () => {
    it('fails closed for a new arbitrary local Claude session without verified hooks', async () => {
      const workingDir = await mkdtemp(join(tmpdir(), 'codeman-route-no-hooks-'));
      // Create now INSTALLS hooks into any claude workspace (applyWorkspaceHooks),
      // so the only way to reach a genuinely hook-less workspace — the condition
      // this fail-closed path exists for — is with the setting off.
      harness.ctx.getWorkspaceHooksEnabled.mockResolvedValue(false);
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: { workingDir, mode: 'claude' },
      });

      expect(res.statusCode).toBe(200);
      const created = harness.ctx.addSession.mock.calls.at(-1)?.[0] as Session;
      created.setCheckpoint(true, ['new']);
      expect(created.requestCheckpoint({ mode: 'new' })).toEqual({
        triggered: false,
        reason: 'session-start-hook-unavailable',
      });
    });

    it('enables a new local Claude session only after current hooks and authoritative SessionStart identity', async () => {
      const workingDir = await mkdtemp(join(tmpdir(), 'codeman-route-current-hooks-'));
      await writeHooksConfig(workingDir);
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: { workingDir, mode: 'claude' },
      });

      expect(res.statusCode).toBe(200);
      const created = harness.ctx.addSession.mock.calls.at(-1)?.[0] as Session;
      created.setCheckpoint(true, ['new']);
      expect(created.requestCheckpoint({ mode: 'new' })).toEqual({
        triggered: false,
        reason: 'baseline-identity-unavailable',
      });
      created.adoptClaudeSessionStartId('route-authoritative-session-id');
      expect(created.requestCheckpoint({ mode: 'new' })).toEqual({ triggered: true, runId: expect.any(String) });
      created.cancelCheckpoint('test-cleanup');
    });

    it('fails closed for a new remote Claude session', async () => {
      remoteStore.hosts = [{ id: 'gpu-box', label: 'GPU Box', host: '10.0.0.42', username: 'ubuntu', commands: {} }];
      remoteStore.cases = [{ name: 'gpu-work', type: 'remote', hostId: 'gpu-box', remotePath: '/home/ubuntu/work' }];
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: { caseName: 'gpu-work', mode: 'claude' },
      });

      expect(res.statusCode).toBe(200);
      const created = harness.ctx.addSession.mock.calls.at(-1)?.[0] as Session;
      created.setCheckpoint(true, ['clear']);
      expect(created.requestCheckpoint({ mode: 'clear' })).toEqual({
        triggered: false,
        reason: 'session-start-hook-unavailable',
      });
    });

    it('seeds a standard new session from the server checkpoint default', async () => {
      remoteStore.hosts = [{ id: 'gpu-box', label: 'GPU Box', host: '10.0.0.42', username: 'ubuntu', commands: {} }];
      remoteStore.cases = [{ name: 'gpu-work', type: 'remote', hostId: 'gpu-box', remotePath: '/home/ubuntu/work' }];
      harness.ctx.getCheckpointDefaultEnabled.mockResolvedValueOnce(true);

      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: { caseName: 'gpu-work', mode: 'shell' },
      });

      expect(res.statusCode).toBe(200);
      const created = harness.ctx.addSession.mock.calls.at(-1)?.[0];
      expect(created?.checkpointEnabled).toBe(true);
    });

    it.each([
      ['opencode', 'OpenCode resolver diagnostic'],
      ['codex', 'Codex resolver diagnostic'],
      ['gemini', 'Gemini resolver diagnostic'],
      ['antigravity', 'Antigravity resolver diagnostic'],
      ['pi', 'Pi resolver diagnostic'],
    ] as const)('returns the exact %s resolver diagnostic for a local create preflight', async (mode, diagnostic) => {
      cliAvailability[mode] = false;

      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: { workingDir: process.env.HOME, mode },
      });

      expect(res.statusCode).toBe(422);
      expect(JSON.parse(res.body)).toMatchObject({ success: false, error: diagnostic });
      expect(harness.ctx.addSession).not.toHaveBeenCalled();
    });

    it('skips local CLI availability preflight for a remote create', async () => {
      remoteStore.hosts = [{ id: 'gpu-box', label: 'GPU Box', host: '10.0.0.42', username: 'ubuntu', commands: {} }];
      remoteStore.cases = [{ name: 'gpu-work', type: 'remote', hostId: 'gpu-box', remotePath: '/home/ubuntu/work' }];
      cliAvailability.codex = false;

      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: { caseName: 'gpu-work', mode: 'codex', name: 'Remote Codex' },
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).data.session).toMatchObject({
        mode: 'codex',
        workingDir: '/home/ubuntu/work',
        remote: expect.objectContaining({ hostId: 'gpu-box' }),
      });
    });

    it('creates session from a remote case without local stat validation', async () => {
      remoteStore.hosts = [
        {
          id: 'gpu-box',
          label: 'GPU Box',
          host: '10.0.0.42',
          username: 'ubuntu',
          commands: { codex: 'exec codx personal' },
        },
      ];
      remoteStore.cases = [
        {
          name: 'gpu-work',
          type: 'remote',
          hostId: 'gpu-box',
          remotePath: '/home/ubuntu/work',
          commands: { codex: 'exec case-codex' },
        },
      ];

      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: { caseName: 'gpu-work', mode: 'shell', name: 'Remote Shell' },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.session.workingDir).toBe('/home/ubuntu/work');
      expect(body.data.session.remote).toMatchObject({
        hostId: 'gpu-box',
        host: '10.0.0.42',
        username: 'ubuntu',
        remotePath: '/home/ubuntu/work',
        commands: { codex: 'exec case-codex' },
      });
    });

    const externalQuickStartModes = [
      ['opencode', 'OpenCode resolver diagnostic', isOpenCodeAvailable],
      ['codex', 'Codex resolver diagnostic', isCodexAvailable],
      ['gemini', 'Gemini resolver diagnostic', isGeminiAvailable],
      ['antigravity', 'Antigravity resolver diagnostic', isAntigravityAvailable],
      ['pi', 'Pi resolver diagnostic', isPiAvailable],
    ] as const;

    it.each(externalQuickStartModes)(
      'returns the exact %s resolver diagnostic for a local quick-start preflight',
      async (mode, diagnostic) => {
        cliAvailability[mode] = false;

        const res = await harness.app.inject({
          method: 'POST',
          url: '/api/quick-start',
          payload: { caseName: 'missing-local-case', mode },
        });

        expect(res.statusCode).toBe(422);
        expect(JSON.parse(res.body)).toMatchObject({ success: false, error: diagnostic });
        expect(harness.ctx.addSession).not.toHaveBeenCalled();
      }
    );

    it.each(
      externalQuickStartModes.flatMap(([mode, , probe]) => [
        [mode, 'remote', probe],
        [mode, 'docker', probe],
      ])
    )('skips the local %s resolver probe for a %s quick-start', async (mode, location, probe) => {
      cliAvailability[mode] = false;
      const caseName = `${location}-${mode}`;
      const expectedPath = `/work/${caseName}`;
      if (location === 'remote') {
        remoteStore.hosts = [{ id: 'gpu-box', label: 'GPU Box', host: '10.0.0.42', username: 'ubuntu', commands: {} }];
        remoteStore.cases = [{ name: caseName, type: 'remote', hostId: 'gpu-box', remotePath: expectedPath }];
      } else {
        dockerStore.hosts = [
          { id: 'docker-local', label: 'Docker Local', engine: 'docker', image: 'codeman/agent:base' },
        ];
        dockerStore.cases = [
          {
            name: caseName,
            type: 'docker',
            hostId: 'docker-local',
            hostWorkspacePath: expectedPath,
          },
        ];
      }
      const startInteractive = vi.spyOn(Session.prototype, 'startInteractive').mockResolvedValue(undefined);

      try {
        const res = await harness.app.inject({
          method: 'POST',
          url: '/api/quick-start',
          payload: { caseName, mode },
        });

        expect(res.statusCode).toBe(200);
        expect(JSON.parse(res.body).data.casePath).toBe(expectedPath);
        expect(probe).not.toHaveBeenCalled();
        expect(startInteractive).toHaveBeenCalledTimes(1);
      } finally {
        startInteractive.mockRestore();
      }
    });

    it('COD-179: passes the creating browser dims through to Session initialDims', async () => {
      remoteStore.hosts = [{ id: 'gpu-box', label: 'GPU Box', host: '10.0.0.42', username: 'ubuntu', commands: {} }];
      remoteStore.cases = [{ name: 'gpu-work', type: 'remote', hostId: 'gpu-box', remotePath: '/home/ubuntu/work' }];

      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: { caseName: 'gpu-work', mode: 'shell', name: 'Sized', cols: 178, rows: 33 },
      });

      expect(res.statusCode).toBe(200);
      const added = (harness.ctx.addSession as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0];
      expect(added).toBeDefined();
      expect((added as unknown as { _initialDims?: { cols: number; rows: number } })._initialDims).toEqual({
        cols: 178,
        rows: 33,
      });
    });

    it('COD-179: rejects out-of-bounds create dims', async () => {
      remoteStore.hosts = [{ id: 'gpu-box', label: 'GPU Box', host: '10.0.0.42', username: 'ubuntu', commands: {} }];
      remoteStore.cases = [{ name: 'gpu-work', type: 'remote', hostId: 'gpu-box', remotePath: '/home/ubuntu/work' }];

      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: { caseName: 'gpu-work', mode: 'shell', cols: 10_000, rows: 33 },
      });

      expect(JSON.parse(res.body).success).toBe(false);
    });

    it('quick-start creates remote case sessions through ssh metadata', async () => {
      const startShell = vi.spyOn(Session.prototype, 'startShell').mockResolvedValue(undefined);
      try {
        remoteStore.hosts = [
          {
            id: 'gpu-box',
            label: 'GPU Box',
            host: '10.0.0.42',
            username: 'ubuntu',
            commands: { codex: 'exec codx personal' },
          },
        ];
        remoteStore.cases = [{ name: 'gpu-work', type: 'remote', hostId: 'gpu-box', remotePath: '/home/ubuntu/work' }];
        harness.ctx.getCheckpointDefaultEnabled.mockResolvedValueOnce(false);

        const res = await harness.app.inject({
          method: 'POST',
          url: '/api/quick-start',
          payload: { caseName: 'gpu-work', mode: 'shell' },
        });

        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(body.success).toBe(true);
        expect(body.data.casePath).toBe('/home/ubuntu/work');
        const session = [...harness.ctx.sessions.values()].find((item) => item.id === body.data.sessionId);
        expect(session?.checkpointEnabled).toBe(false);
        expect(session?.toState()).toMatchObject({
          workingDir: '/home/ubuntu/work',
          remote: expect.objectContaining({
            hostId: 'gpu-box',
            host: '10.0.0.42',
            username: 'ubuntu',
            remotePath: '/home/ubuntu/work',
          }),
        });
      } finally {
        startShell.mockRestore();
      }
    });

    it('rejects a remote quick-start that carries envOverrides (inert over ssh)', async () => {
      remoteStore.hosts = [{ id: 'gpu-box', label: 'GPU Box', host: '10.0.0.42', username: 'ubuntu' }];
      remoteStore.cases = [{ name: 'gpu-work', type: 'remote', hostId: 'gpu-box', remotePath: '/home/ubuntu/work' }];

      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/quick-start',
        payload: { caseName: 'gpu-work', mode: 'claude', envOverrides: { CLAUDE_CODE_FOO: 'bar' } },
      });

      expect(res.statusCode).toBe(httpStatusForErrorCode(ApiErrorCode.INVALID_INPUT));
      expect(JSON.parse(res.body)).toMatchObject({ success: false, errorCode: ApiErrorCode.INVALID_INPUT });
    });

    it('rejects a remote quick-start when the remote host lacks tmux', async () => {
      remoteStore.hosts = [{ id: 'gpu-box', label: 'GPU Box', host: '10.0.0.42', username: 'ubuntu' }];
      remoteStore.cases = [{ name: 'gpu-work', type: 'remote', hostId: 'gpu-box', remotePath: '/home/ubuntu/work' }];
      remoteStore.tmuxCheck = {
        ok: false,
        error: 'remote host 10.0.0.42 needs tmux installed for durable remote sessions',
      };

      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/quick-start',
        payload: { caseName: 'gpu-work', mode: 'shell' },
      });

      expect(res.statusCode).toBe(httpStatusForErrorCode(ApiErrorCode.OPERATION_FAILED));
      expect(JSON.parse(res.body)).toMatchObject({ success: false, errorCode: ApiErrorCode.OPERATION_FAILED });
    });

    describe('remote create/attach wakes a sleeping host (Wake-on-LAN)', () => {
      const host = (extra: Record<string, unknown> = {}) => ({
        id: 'hufflepuff',
        label: 'Hufflepuff',
        host: '192.168.50.137',
        username: 'j',
        wakeMac: '04:d9:f5:80:c6:58',
        ...extra,
      });
      const remoteCase = { name: 'hufflepuff-work', type: 'remote', hostId: 'hufflepuff', remotePath: '/home/j/work' };
      const quickStart = () =>
        harness.app.inject({
          method: 'POST',
          url: '/api/quick-start',
          payload: { caseName: 'hufflepuff-work', mode: 'shell' },
        });

      it('wakes the host before the tmux probe when the user runs a remote case', async () => {
        const startShell = vi.spyOn(Session.prototype, 'startShell').mockResolvedValue(undefined);
        try {
          remoteStore.hosts = [host()];
          remoteStore.cases = [remoteCase];
          wakeProbe.mockResolvedValue(false); // asleep

          const res = await quickStart();

          expect(res.statusCode).toBe(200);
          expect(JSON.parse(res.body).success).toBe(true);
          expect(wakeCommandRun).toHaveBeenCalledWith({ kind: 'mac', macs: [[4, 217, 245, 128, 198, 88]] });
          // The request budget, not the 90 s session default: the reverse proxy would
          // cut the request at 60 s while the session was still being built.
          expect(wakeWaitUntilReady).toHaveBeenCalledWith(expect.objectContaining({ hostId: 'hufflepuff' }), {
            timeoutMs: expect.any(Number),
            // The shutdown signal rides along so `WebServer.stop()` can end the poll.
            signal: expect.any(AbortSignal),
          });
          // Not asserted to the millisecond: the wake's own elapsed time is subtracted,
          // so a slow runner lands a few ms under the budget.
          const [, readyOpts] = wakeWaitUntilReady.mock.calls[0] as unknown as [unknown, { timeoutMs: number }];
          expect(readyOpts.timeoutMs).toBeLessThanOrEqual(REMOTE_WAKE_REQUEST_READY_TIMEOUT_MS);
          expect(readyOpts.timeoutMs).toBeGreaterThan(REMOTE_WAKE_REQUEST_READY_TIMEOUT_MS - 1_000);
        } finally {
          startShell.mockRestore();
        }
      });

      it('does not wake a host that answers, and never probes a host without a wake target', async () => {
        const startShell = vi.spyOn(Session.prototype, 'startShell').mockResolvedValue(undefined);
        try {
          remoteStore.hosts = [host()];
          remoteStore.cases = [remoteCase];
          // The fake probe answers `true` by default — a reachable host.
          expect((await quickStart()).statusCode).toBe(200);
          expect(wakeCommandRun).not.toHaveBeenCalled();

          // No wake target at all: not even a probe, so hosts without WoL keep the
          // exact behavior (and latency) they had before this feature.
          wakeProbe.mockClear();
          remoteStore.hosts = [host({ wakeMac: undefined })];
          expect((await quickStart()).statusCode).toBe(200);
          expect(wakeProbe).not.toHaveBeenCalled();
          expect(wakeCommandRun).not.toHaveBeenCalled();
        } finally {
          startShell.mockRestore();
        }
      });

      it('refuses the run when the host never comes back, and starts no session', async () => {
        remoteStore.hosts = [host()];
        remoteStore.cases = [remoteCase];
        wakeProbe.mockResolvedValue(false);
        wakeWaitUntilReady.mockResolvedValue(false);
        const sessionsBefore = harness.ctx.sessions.size;

        const res = await quickStart();

        expect(res.statusCode).toBe(httpStatusForErrorCode(ApiErrorCode.OPERATION_FAILED));
        expect(JSON.parse(res.body).error).toMatch(/did not come back after a wake-on-LAN request/);
        // No half-created session: the failure is the answer, not a dead tab.
        expect(harness.ctx.sessions.size).toBe(sessionsBefore);
      });

      it('blames the sleeping host, not tmux, when the host has no wake target', async () => {
        remoteStore.hosts = [host({ wakeMac: undefined })];
        remoteStore.cases = [remoteCase];
        remoteStore.tmuxCheck = {
          ok: false,
          error: 'remote host 192.168.50.137 needs tmux installed for durable remote sessions',
        };
        wakeProbe.mockResolvedValue(false);

        const res = await quickStart();

        expect(res.statusCode).toBe(httpStatusForErrorCode(ApiErrorCode.OPERATION_FAILED));
        expect(JSON.parse(res.body).error).toMatch(/has no wake-on-LAN target/);
      });

      it('keeps the tmux error when the host is up but tmux is really missing', async () => {
        remoteStore.hosts = [host()];
        remoteStore.cases = [remoteCase];
        remoteStore.tmuxCheck = {
          ok: false,
          error: 'remote host 192.168.50.137 needs tmux installed for durable remote sessions',
        };
        // Probe answers `true`: the ssh failure is genuinely about tmux.

        const res = await quickStart();

        expect(JSON.parse(res.body).error).toMatch(/needs tmux installed/);
      });

      it('wakes the host when attaching to a discovered remote session', async () => {
        const startInteractive = vi.spyOn(Session.prototype, 'startInteractive').mockResolvedValue(undefined);
        const startShell = vi.spyOn(Session.prototype, 'startShell').mockResolvedValue(undefined);
        try {
          remoteStore.hosts = [host()];
          wakeProbe.mockResolvedValue(false);

          const res = await harness.app.inject({
            method: 'POST',
            url: '/api/sessions',
            payload: { attachRemoteSession: { hostId: 'hufflepuff', remoteSessionName: 'codeman-abc12345' } },
          });

          expect(res.statusCode).toBe(200);
          expect(wakeCommandRun).toHaveBeenCalledTimes(1);
        } finally {
          startInteractive.mockRestore();
          startShell.mockRestore();
        }
      });
    });

    it('does not run local codex availability check for a remote codex case', async () => {
      // A remote codex case must NOT be blocked by the LOCAL codex availability gate
      // (the CLI runs on the remote host). Probe is stubbed ok in remoteStore.tmuxCheck.
      const startInteractive = vi.spyOn(Session.prototype, 'startInteractive').mockResolvedValue(undefined);
      try {
        remoteStore.hosts = [
          { id: 'gpu-box', label: 'GPU Box', host: '10.0.0.42', username: 'ubuntu', commands: { codex: 'exec codx' } },
        ];
        remoteStore.cases = [{ name: 'gpu-work', type: 'remote', hostId: 'gpu-box', remotePath: '/home/ubuntu/work' }];

        const res = await harness.app.inject({
          method: 'POST',
          url: '/api/quick-start',
          payload: { caseName: 'gpu-work', mode: 'codex' },
        });

        expect(res.statusCode).toBe(200);
        expect(JSON.parse(res.body).success).toBe(true);
      } finally {
        startInteractive.mockRestore();
      }
    });

    it('creates session with valid resumeSessionId', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: {
          name: 'resume-test',
          mode: 'claude',
          workingDir: process.env.HOME || '/tmp',
          resumeSessionId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
        },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.session).toBeDefined();
    });

    it('rejects invalid resumeSessionId format', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: {
          name: 'bad-resume',
          mode: 'claude',
          workingDir: process.env.HOME || '/tmp',
          resumeSessionId: 'not-a-uuid',
        },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });

    it('creates session without resumeSessionId (optional field)', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: {
          name: 'no-resume',
          mode: 'claude',
          workingDir: process.env.HOME || '/tmp',
        },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
    });
  });
});
