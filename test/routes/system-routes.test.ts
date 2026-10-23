/**
 * @fileoverview Tests for system route handlers.
 *
 * Uses app.inject() — no real HTTP ports needed.
 * Port: N/A (app.inject doesn't open ports)
 *
 * Mocks: fs (promises + sync), subagentWatcher, imageWatcher,
 * session-lifecycle-log, and CLI resolver singletons.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRouteTestHarness, type RouteTestHarness } from './_route-test-utils.js';
import { registerSystemRoutes } from '../../src/web/routes/system-routes.js';

// ── Mocks ──────────────────────────────────────────────────────────

vi.mock('node:fs/promises', () => ({
  default: {
    readFile: vi.fn(async () => '{}'),
    writeFile: vi.fn(async () => undefined),
  },
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: vi.fn(() => true),
    mkdirSync: vi.fn(),
    readdirSync: vi.fn(() => []),
  };
});

vi.mock('../../src/subagent-watcher.js', () => ({
  subagentWatcher: {
    getSubagents: vi.fn(() => []),
    getRecentSubagents: vi.fn(() => []),
    getSubagentsForSession: vi.fn(() => []),
    getSubagentsForConversation: vi.fn(() => []),
    getSubagent: vi.fn(() => null),
    resolveSubagentReference: vi.fn(() => ({ status: 'not_found' })),
    getTranscript: vi.fn(async () => []),
    formatTranscript: vi.fn(() => ''),
    killSubagent: vi.fn(async () => false),
    cleanupNow: vi.fn(() => 0),
    clearAll: vi.fn(() => 0),
    getStats: vi.fn(() => ({
      totalAgents: 0,
      activeAgents: 0,
      fileDebouncerCount: 0,
      dirWatcherCount: 0,
      idleTimerCount: 0,
    })),
    isRunning: vi.fn(() => true),
    start: vi.fn(),
    stop: vi.fn(),
  },
}));

vi.mock('../../src/image-watcher.js', () => ({
  imageWatcher: {
    isRunning: vi.fn(() => false),
    start: vi.fn(),
    stop: vi.fn(),
    watchSession: vi.fn(),
  },
}));

vi.mock('../../src/session-lifecycle-log.js', () => ({
  getLifecycleLog: vi.fn(() => ({
    log: vi.fn(),
    query: vi.fn(async () => []),
  })),
}));

vi.mock('../../src/web/repo-status.js', () => ({
  getRepositoryStatus: vi.fn(async () => ({
    installType: 'git',
    branch: 'local',
    upstream: { remote: 'upstream', ahead: 0, behind: 0, incoming: [] },
    fork: { remote: 'origin', ahead: 0, behind: 0, incoming: [] },
  })),
}));

vi.mock('../../src/utils/opencode-cli-resolver.js', () => ({
  isOpenCodeAvailable: vi.fn(() => false),
  resolveOpenCodeDir: vi.fn(() => null),
  getOpenCodeNotFoundMessage: vi.fn(() => 'OpenCode resolver diagnostic'),
}));

vi.mock('../../src/utils/claude-cli-resolver.js', () => ({
  isClaudeAvailable: vi.fn(() => false),
  findClaudeDir: vi.fn(() => null),
  getClaudeNotFoundMessage: vi.fn(() => 'Claude resolver diagnostic'),
}));

vi.mock('../../src/utils/codex-cli-resolver.js', () => ({
  isCodexAvailable: vi.fn(() => false),
  resolveCodexDir: vi.fn(() => null),
  getCodexNotFoundMessage: vi.fn(() => 'Codex resolver diagnostic'),
}));

vi.mock('../../src/utils/gemini-cli-resolver.js', () => ({
  isGeminiAvailable: vi.fn(() => false),
  resolveGeminiDir: vi.fn(() => null),
  getGeminiNotFoundMessage: vi.fn(() => 'Gemini resolver diagnostic'),
}));

vi.mock('../../src/utils/antigravity-cli-resolver.js', () => ({
  isAntigravityAvailable: vi.fn(() => false),
  resolveAntigravityDir: vi.fn(() => null),
  getAntigravityNotFoundMessage: vi.fn(() => 'Antigravity resolver diagnostic'),
}));

vi.mock('../../src/utils/pi-cli-resolver.js', () => ({
  isPiAvailable: vi.fn(() => false),
  resolvePiDir: vi.fn(() => null),
  getPiCliVersion: vi.fn(() => null),
  getPiNotFoundMessage: vi.fn(() => 'Pi resolver diagnostic'),
}));

import fs from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { subagentWatcher } from '../../src/subagent-watcher.js';
import { getLifecycleLog } from '../../src/session-lifecycle-log.js';
import { findClaudeDir } from '../../src/utils/claude-cli-resolver.js';
import { resolveOpenCodeDir } from '../../src/utils/opencode-cli-resolver.js';
import { resolveCodexDir } from '../../src/utils/codex-cli-resolver.js';
import { resolveGeminiDir } from '../../src/utils/gemini-cli-resolver.js';
import { resolveAntigravityDir } from '../../src/utils/antigravity-cli-resolver.js';
import { resolvePiDir, getPiCliVersion } from '../../src/utils/pi-cli-resolver.js';

const mockedReadFile = vi.mocked(fs.readFile);
const mockedWriteFile = vi.mocked(fs.writeFile);
const mockedExistsSync = vi.mocked(existsSync);
const mockedReaddirSync = vi.mocked(readdirSync);
const mockedSubagentWatcher = vi.mocked(subagentWatcher);
const mockedGetLifecycleLog = vi.mocked(getLifecycleLog);
const mockedFindClaudeDir = vi.mocked(findClaudeDir);
const mockedResolveOpenCodeDir = vi.mocked(resolveOpenCodeDir);
const mockedResolveCodexDir = vi.mocked(resolveCodexDir);
const mockedResolveGeminiDir = vi.mocked(resolveGeminiDir);
const mockedResolveAntigravityDir = vi.mocked(resolveAntigravityDir);
const mockedResolvePiDir = vi.mocked(resolvePiDir);
const mockedGetPiCliVersion = vi.mocked(getPiCliVersion);

describe('system-routes', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestHarness(registerSystemRoutes);
    vi.clearAllMocks();

    // Re-apply defaults after clearAllMocks
    mockedReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    mockedWriteFile.mockResolvedValue(undefined);
    mockedExistsSync.mockReturnValue(true);
    mockedReaddirSync.mockReturnValue([]);
    mockedSubagentWatcher.getSubagents.mockReturnValue([]);
    mockedSubagentWatcher.resolveSubagentReference.mockReturnValue({ status: 'not_found' });
    mockedSubagentWatcher.getStats.mockReturnValue({
      totalAgents: 0,
      activeAgents: 0,
      fileDebouncerCount: 0,
      dirWatcherCount: 0,
      idleTimerCount: 0,
    } as never);
    mockedGetLifecycleLog.mockReturnValue({
      log: vi.fn(),
      query: vi.fn(async () => []),
    } as never);
    mockedFindClaudeDir.mockReturnValue(null);
    mockedResolveOpenCodeDir.mockReturnValue(null);
    mockedResolveCodexDir.mockReturnValue(null);
    mockedResolveGeminiDir.mockReturnValue(null);
    mockedResolveAntigravityDir.mockReturnValue(null);
    mockedResolvePiDir.mockReturnValue(null);
    mockedGetPiCliVersion.mockReturnValue(null);
  });

  afterEach(async () => {
    await harness.app.close();
  });

  // ========== GET /api/status ==========

  describe('GET /api/status', () => {
    it('returns server status', async () => {
      const res = await harness.app.inject({ method: 'GET', url: '/api/status' });
      expect(res.statusCode).toBe(200);
      expect(harness.ctx.getLightState).toHaveBeenCalled();
    });
  });

  // ========== GET /api/headroom/status ==========

  describe('GET /api/headroom/status', () => {
    it('keeps proxy-wide Claude activity separate from a direct Codex launch snapshot', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => {
          if (url.endsWith('/readyz')) return { ok: true, json: async () => ({ version: '0.25.0' }) } as Response;
          return {
            ok: true,
            json: async () => ({
              summary: { api_requests: 8, compression: {}, cost: {} },
              agent_usage: {
                agents: [
                  {
                    agent: 'claude-code',
                    label: 'Claude Code',
                    source: 'client',
                    requests: 8,
                    tokens_saved: 99,
                    savings_percent: 50,
                    providers: { anthropic: 8 },
                  },
                ],
              },
              requests: { by_provider: { anthropic: 8 }, by_model: {}, by_stack: { proxy: 8 } },
            }),
          } as Response;
        })
      );
      const session = harness.ctx._session as typeof harness.ctx._session & {
        headroomRouted?: boolean;
        headroomRoutedAt?: number;
      };
      session.mode = 'codex';
      session.headroomRouted = false;
      session.headroomRoutedAt = 1_722_470_400_000;

      const res = await harness.app.inject({ method: 'GET', url: '/api/headroom/status' });
      const body = JSON.parse(res.body);

      expect(res.statusCode).toBe(200);
      expect(body.stats.attribution.agents).toEqual([
        expect.objectContaining({ agent: 'claude-code', label: 'Claude Code', requests: 8 }),
      ]);
      expect(body.routedSessions).toEqual([
        expect.objectContaining({ mode: 'codex', routed: false, routedAt: 1_722_470_400_000 }),
      ]);
    });
  });

  // ========== GET /api/config ==========

  describe('GET /api/config', () => {
    it('returns config', async () => {
      const res = await harness.app.inject({ method: 'GET', url: '/api/config' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.config).toBeDefined();
    });
  });

  // ========== PUT /api/config ==========

  describe('PUT /api/config', () => {
    it('updates config with valid payload', async () => {
      const res = await harness.app.inject({
        method: 'PUT',
        url: '/api/config',
        payload: { maxConcurrentSessions: 10 },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.config).toBeDefined();
      expect(harness.ctx.store.setConfig).toHaveBeenCalled();
    });

    it('rejects unknown config fields (strict schema)', async () => {
      const res = await harness.app.inject({
        method: 'PUT',
        url: '/api/config',
        payload: { unknownField: 'invalid' },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.message ?? body.error).toBeTruthy();
    });
  });

  // ========== GET /api/stats ==========

  describe('GET /api/stats', () => {
    it('returns aggregate stats', async () => {
      const res = await harness.app.inject({ method: 'GET', url: '/api/stats' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.stats).toBeDefined();
    });
  });

  // ========== GET /api/token-stats ==========

  describe('GET /api/token-stats', () => {
    it('returns daily and aggregate token stats', async () => {
      const res = await harness.app.inject({ method: 'GET', url: '/api/token-stats' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.daily).toBeDefined();
      expect(body.totals).toBeDefined();
    });
  });

  // ========== GET /api/away-digest ==========

  describe('GET /api/away-digest', () => {
    it('returns a classified digest from lifecycle, active sessions, and token stats', async () => {
      const lifecycleQuery = vi.fn(async () => [
        {
          ts: Date.now() - 1000,
          event: 'exit',
          sessionId: harness.ctx._sessionId,
          name: 'Route Session',
          exitCode: 7,
        },
      ]);
      mockedGetLifecycleLog.mockReturnValue({
        log: vi.fn(),
        query: lifecycleQuery,
      } as never);
      harness.ctx._session.name = 'Route Session';
      harness.ctx._session.status = 'working';
      harness.ctx.store.getDailyStats.mockReturnValue([
        {
          // LOCAL date (not toISOString/UTC): away-digest's dayOverlapsRange parses
          // the date as local midnight, so a UTC date near the local-midnight boundary
          // (e.g. running at 01:xx CEST = prior-day UTC) would fall outside the 1h
          // window and make this assertion TZ/hour-flaky.
          date: new Date().toLocaleDateString('en-CA'),
          inputTokens: 100,
          outputTokens: 200,
          estimatedCost: 0.02,
          sessions: 1,
        },
      ]);

      const res = await harness.app.inject({ method: 'GET', url: '/api/away-digest?range=1h' });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.digest.sections.needsAttention[0]).toMatchObject({
        sessionId: harness.ctx._sessionId,
        source: 'lifecycle',
      });
      expect(body.digest.sections.stillRunning[0]).toMatchObject({
        sessionId: harness.ctx._sessionId,
        source: 'status',
      });
      expect(body.digest.totals).toMatchObject({
        activeSessions: 1,
        needsAttention: 1,
        inputTokens: 100,
        outputTokens: 200,
        tokenWindowPrecision: 'day',
      });
      expect(lifecycleQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          limit: 1000,
        })
      );
    });

    it('rejects invalid ranges', async () => {
      const res = await harness.app.inject({ method: 'GET', url: '/api/away-digest?range=forever' });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.message ?? body.error).toMatch(/range/i);
    });
  });

  // ========== GET /api/debug/memory ==========

  describe('GET /api/debug/memory', () => {
    it('returns memory and map usage info', async () => {
      const res = await harness.app.inject({ method: 'GET', url: '/api/debug/memory' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.memory).toBeDefined();
      expect(body.memory.rssMB).toBeGreaterThan(0);
      expect(body.mapSizes).toBeDefined();
      expect(body.uptime).toBeDefined();
    });
  });

  // ========== GET /api/system/stats ==========

  describe('GET /api/system/stats', () => {
    it('returns CPU and memory stats', async () => {
      const res = await harness.app.inject({ method: 'GET', url: '/api/system/stats' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toHaveProperty('cpu');
      expect(body).toHaveProperty('memory');
    });
  });

  // ========== GET /api/system/repo-status ==========

  describe('GET /api/system/repo-status', () => {
    it('registers once and returns repository status', async () => {
      const res = await harness.app.inject({ method: 'GET', url: '/api/system/repo-status' });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toMatchObject({
        installType: 'git',
        branch: 'local',
      });
    });
  });

  // ========== POST /api/cleanup-state ==========

  describe('POST /api/cleanup-state', () => {
    it('deletes only the session ids revalidated by the layout service', async () => {
      const confirmedIds = new Set(['confirmed-stale']);
      const runStaleSessionCleanup = vi.fn(
        async (_activeIds: Set<string>, action: (ids: ReadonlySet<string>) => unknown) => action(confirmedIds)
      );
      harness.ctx.tabLayouts.runStaleSessionCleanup = runStaleSessionCleanup;
      const res = await harness.app.inject({ method: 'POST', url: '/api/cleanup-state' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.cleanedSessions).toBe(0);
      expect(harness.ctx.store.cleanupSessionsByIds).toHaveBeenCalledWith(confirmedIds);
      expect(harness.ctx.store.cleanupStaleSessions).not.toHaveBeenCalled();
      expect(runStaleSessionCleanup).toHaveBeenCalledOnce();
    });
  });

  // ========== GET /api/subagents ==========

  describe('GET /api/subagents', () => {
    it('returns subagent list', async () => {
      const res = await harness.app.inject({ method: 'GET', url: '/api/subagents' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data).toBeDefined();
    });

    it('filters by minutes when query param provided', async () => {
      mockedSubagentWatcher.getRecentSubagents.mockReturnValue([]);
      const res = await harness.app.inject({ method: 'GET', url: '/api/subagents?minutes=30' });
      expect(res.statusCode).toBe(200);
      expect(mockedSubagentWatcher.getRecentSubagents).toHaveBeenCalledWith(30);
    });
  });

  // ========== POST /api/auth/revoke ==========

  describe('POST /api/auth/revoke', () => {
    it('returns success even without auth sessions', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/auth/revoke',
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toEqual({});
    });

    it('revokes a specific session token', async () => {
      const authSessions = new Map();
      authSessions.set('tok-123', { ip: '1.2.3.4', ua: 'test', createdAt: Date.now(), method: 'basic' });
      harness.ctx.authSessions = authSessions;

      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/auth/revoke',
        payload: { sessionToken: 'tok-123' },
      });
      expect(res.statusCode).toBe(200);
      expect(authSessions.has('tok-123')).toBe(false);
    });

    it('clears all sessions when no token specified', async () => {
      const authSessions = new Map();
      authSessions.set('a', { ip: '1', ua: '', createdAt: 0, method: 'basic' });
      authSessions.set('b', { ip: '2', ua: '', createdAt: 0, method: 'qr' });
      harness.ctx.authSessions = authSessions;

      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/auth/revoke',
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      expect(authSessions.size).toBe(0);
    });
  });

  // ========== GET /api/settings ==========

  describe('GET /api/settings', () => {
    // A plain read that never writes. The route briefly reconciled an absent
    // showPlanUsageLimits to true on first read, but readJsonConfig() answers {}
    // for ANY read failure and every page load hits this route, so one unlucky
    // read replaced the whole file with a one-key file. The default now lives in
    // readPlanUsageTelemetryEnabled() (absent means ON); see also
    // system-routes-settings-get-plan-usage-default.test.ts.
    it('answers {} for a missing settings file and creates nothing', async () => {
      mockedReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      mockedWriteFile.mockClear();

      const res = await harness.app.inject({ method: 'GET', url: '/api/settings' });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({});
      expect(mockedWriteFile).not.toHaveBeenCalled();
    });

    it('returns the file unchanged when showPlanUsageLimits is absent', async () => {
      const settings = { subagentTrackingEnabled: true, showSystemStats: false };
      mockedReadFile.mockResolvedValue(JSON.stringify(settings) as never);
      mockedWriteFile.mockClear();

      const res = await harness.app.inject({ method: 'GET', url: '/api/settings' });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual(settings);
      expect(mockedWriteFile).not.toHaveBeenCalled();
    });

    it('passes an explicit false through untouched', async () => {
      const settings = { subagentTrackingEnabled: true, showPlanUsageLimits: false };
      mockedReadFile.mockResolvedValue(JSON.stringify(settings) as never);
      mockedWriteFile.mockClear();

      const res = await harness.app.inject({ method: 'GET', url: '/api/settings' });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual(settings);
      expect(mockedWriteFile).not.toHaveBeenCalled();
    });
  });

  // ========== PUT /api/settings ==========

  describe('PUT /api/settings', () => {
    it('persists and returns checkpointDefaultEnabled across a settings round-trip', async () => {
      mockedReadFile.mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

      const put = await harness.app.inject({
        method: 'PUT',
        url: '/api/settings',
        payload: { checkpointDefaultEnabled: false },
      });

      expect(put.statusCode).toBe(200);
      const written = mockedWriteFile.mock.calls.at(-1)?.[1] as string;
      expect(JSON.parse(written).checkpointDefaultEnabled).toBe(false);
      mockedReadFile.mockResolvedValueOnce(written as never);

      const get = await harness.app.inject({ method: 'GET', url: '/api/settings' });
      expect(get.statusCode).toBe(200);
      expect(JSON.parse(get.body).checkpointDefaultEnabled).toBe(false);
    });

    it('saves valid settings', async () => {
      mockedReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

      const res = await harness.app.inject({
        method: 'PUT',
        url: '/api/settings',
        payload: { showSystemStats: true, subagentTrackingEnabled: false },
      });
      expect(res.statusCode).toBe(200);
      expect(mockedWriteFile).toHaveBeenCalled();
    });

    // COD-242: keyboard shortcut overrides must persist server-side so they survive
    // restarts, deploys, and upgrades. Previously shortcutOverrides was absent from
    // the strict SettingsUpdateSchema, so the PUT 400'd and overrides never persisted.
    const SHORTCUT_OVERRIDES = {
      'command-palette': { bindings: [{ key: 'p', code: 'KeyP', modifiers: ['ctrl', 'shift'] }] },
      search: { disabled: true },
    };

    it('persists shortcutOverrides to settings.json (durable across restart/upgrade)', async () => {
      mockedReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

      const res = await harness.app.inject({
        method: 'PUT',
        url: '/api/settings',
        payload: { shortcutOverrides: SHORTCUT_OVERRIDES },
      });

      expect(res.statusCode).toBe(200);
      const written = JSON.parse(mockedWriteFile.mock.calls[0][1] as string);
      expect(written.shortcutOverrides).toEqual(SHORTCUT_OVERRIDES);
    });

    it('accepts shortcutOverrides alongside other settings without 400', async () => {
      mockedReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

      const res = await harness.app.inject({
        method: 'PUT',
        url: '/api/settings',
        payload: { showSystemStats: true, shortcutOverrides: SHORTCUT_OVERRIDES },
      });

      expect(res.statusCode).toBe(200);
    });

    it('saves terminal history settings and applies tmux history immediately', async () => {
      mockedReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

      const res = await harness.app.inject({
        method: 'PUT',
        url: '/api/settings',
        payload: {
          terminalScrollbackLines: 100000,
          tmuxHistoryLimit: 100000,
          terminalBufferMaxBytes: 32 * 1024 * 1024,
          terminalBufferTrimBytes: 24 * 1024 * 1024,
        },
      });

      expect(res.statusCode).toBe(200);
      const writtenContent = JSON.parse(mockedWriteFile.mock.calls[0][1] as string);
      expect(writtenContent).toMatchObject({
        terminalScrollbackLines: 100000,
        tmuxHistoryLimit: 100000,
        terminalBufferMaxBytes: 32 * 1024 * 1024,
        terminalBufferTrimBytes: 24 * 1024 * 1024,
      });
      expect(harness.ctx.mux.setHistoryLimit).toHaveBeenCalledWith(100000);
    });

    it('rejects invalid terminal history settings', async () => {
      const res = await harness.app.inject({
        method: 'PUT',
        url: '/api/settings',
        payload: {
          terminalScrollbackLines: 0,
          tmuxHistoryLimit: 100000,
          terminalBufferMaxBytes: 1024,
          terminalBufferTrimBytes: 2048,
        },
      });

      expect(res.statusCode).toBe(400);
    });

    it('merges with existing settings', async () => {
      mockedReadFile.mockResolvedValue(JSON.stringify({ showCost: true }) as never);

      const res = await harness.app.inject({
        method: 'PUT',
        url: '/api/settings',
        payload: { showTokenCount: false },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({});

      // Verify writeFile was called with merged content
      const writtenContent = JSON.parse(mockedWriteFile.mock.calls[0][1] as string);
      expect(writtenContent.showCost).toBe(true);
      expect(writtenContent.showTokenCount).toBe(false);
    });

    it('accepts the opt-in automatic reboot recovery setting', async () => {
      const res = await harness.app.inject({
        method: 'PUT',
        url: '/api/settings',
        payload: { autoRecoverSessionsAfterReboot: true },
      });
      expect(res.statusCode).toBe(200);
      const writtenContent = JSON.parse(mockedWriteFile.mock.calls[0][1] as string);
      expect(writtenContent.autoRecoverSessionsAfterReboot).toBe(true);
    });

    it('rejects unknown settings fields (strict schema)', async () => {
      const res = await harness.app.inject({
        method: 'PUT',
        url: '/api/settings',
        payload: { unknownField: 'bad' },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.message ?? body.error).toBeTruthy();
    });

    it('saves lastUsedCase as partial update without overwriting other settings', async () => {
      mockedReadFile.mockResolvedValue(
        JSON.stringify({ showCost: true, showTokenCount: false, subagentTrackingEnabled: true }) as never
      );

      const res = await harness.app.inject({
        method: 'PUT',
        url: '/api/settings',
        payload: { lastUsedCase: 'my-test-case' },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({});

      const writtenContent = JSON.parse(mockedWriteFile.mock.calls[0][1] as string);
      expect(writtenContent.lastUsedCase).toBe('my-test-case');
      expect(writtenContent.showCost).toBe(true);
      expect(writtenContent.showTokenCount).toBe(false);
      expect(writtenContent.subagentTrackingEnabled).toBe(true);
    });

    it('rejects settings with modelConfig (strict schema prevents full-object PUT)', async () => {
      const res = await harness.app.inject({
        method: 'PUT',
        url: '/api/settings',
        payload: { lastUsedCase: 'test', modelConfig: { model: 'something' } },
      });
      // Fastify rejects unknown fields at schema validation level (400) before handler runs
      expect(res.statusCode).toBe(400);
    });

    it('rejects non-object body', async () => {
      const res = await harness.app.inject({
        method: 'PUT',
        url: '/api/settings',
        payload: 'not-an-object',
        headers: { 'content-type': 'application/json' },
      });
      // Fastify will reject non-object JSON before it reaches the handler
      expect(res.statusCode).not.toBe(200);
    });
  });

  // ========== GET /api/subagent-window-states ==========

  describe('GET /api/subagent-window-states', () => {
    it('returns default when file does not exist', async () => {
      mockedReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

      const res = await harness.app.inject({ method: 'GET', url: '/api/subagent-window-states' });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ minimized: {}, open: [] });
    });

    it('returns persisted window states', async () => {
      const states = { minimized: { 'agent-1': true }, open: ['agent-2'] };
      mockedReadFile.mockResolvedValue(JSON.stringify(states) as never);

      const res = await harness.app.inject({ method: 'GET', url: '/api/subagent-window-states' });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual(states);
    });
  });

  // ========== PUT /api/subagent-window-states ==========

  describe('PUT /api/subagent-window-states', () => {
    it('isolates Alice and Bob while reserving legacy global state for an admin', async () => {
      const priorMode = process.env.CODEMAN_MULTIUSER;
      process.env.CODEMAN_MULTIUSER = '1';
      let persisted = JSON.stringify({ minimized: { legacy: true }, open: [] });
      mockedReadFile.mockImplementation(async () => persisted as never);
      mockedWriteFile.mockImplementation(async (_path, value) => {
        persisted = String(value);
      });
      const alice = await createRouteTestHarness(registerSystemRoutes, {
        authUser: { username: 'alice', role: 'user' },
      });
      const bob = await createRouteTestHarness(registerSystemRoutes, {
        authUser: { username: 'bob', role: 'user' },
      });
      const admin = await createRouteTestHarness(registerSystemRoutes, {
        authUser: { username: 'root', role: 'admin' },
      });
      try {
        expect(
          JSON.parse((await alice.app.inject({ method: 'GET', url: '/api/subagent-window-states' })).body)
        ).toEqual({
          minimized: {},
          open: [],
        });
        await alice.app.inject({
          method: 'PUT',
          url: '/api/subagent-window-states',
          payload: { minimized: { alice: true }, open: [] },
        });
        expect(JSON.parse((await bob.app.inject({ method: 'GET', url: '/api/subagent-window-states' })).body)).toEqual({
          minimized: {},
          open: [],
        });
        await bob.app.inject({
          method: 'PUT',
          url: '/api/subagent-window-states',
          payload: { minimized: { bob: true }, open: [] },
        });
        expect(
          JSON.parse((await alice.app.inject({ method: 'GET', url: '/api/subagent-window-states' })).body)
        ).toEqual({
          minimized: { alice: true },
          open: [],
        });
        expect(
          JSON.parse((await admin.app.inject({ method: 'GET', url: '/api/subagent-window-states' })).body)
        ).toEqual({
          minimized: { legacy: true },
          open: [],
        });
      } finally {
        await Promise.all([alice.app.close(), bob.app.close(), admin.app.close()]);
        if (priorMode === undefined) delete process.env.CODEMAN_MULTIUSER;
        else process.env.CODEMAN_MULTIUSER = priorMode;
      }
    });

    it('saves valid window states', async () => {
      const res = await harness.app.inject({
        method: 'PUT',
        url: '/api/subagent-window-states',
        payload: { minimized: { 'agent-1': true }, open: ['agent-2'] },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({});
      expect(mockedWriteFile).toHaveBeenCalled();
    });

    it('accepts empty state', async () => {
      const res = await harness.app.inject({
        method: 'PUT',
        url: '/api/subagent-window-states',
        payload: { minimized: {}, open: [] },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({});
    });

    it('rejects invalid minimized values', async () => {
      const res = await harness.app.inject({
        method: 'PUT',
        url: '/api/subagent-window-states',
        payload: { minimized: { 'agent-1': 'not-a-boolean' } },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.message ?? body.error).toBeTruthy();
    });
  });

  // ========== GET /api/subagent-parents ==========

  describe('GET /api/subagent-parents', () => {
    it('returns empty object when file does not exist', async () => {
      mockedReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

      const res = await harness.app.inject({ method: 'GET', url: '/api/subagent-parents' });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({});
    });

    it('returns persisted parent map', async () => {
      const parents = { 'agent-1': 'session-abc', 'agent-2': 'session-xyz' };
      mockedReadFile.mockResolvedValue(JSON.stringify(parents) as never);

      const res = await harness.app.inject({ method: 'GET', url: '/api/subagent-parents' });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual(parents);
    });
  });

  // ========== PUT /api/subagent-parents ==========

  describe('PUT /api/subagent-parents', () => {
    it('isolates parent associations by owner and exposes legacy associations only to admin', async () => {
      const priorMode = process.env.CODEMAN_MULTIUSER;
      process.env.CODEMAN_MULTIUSER = '1';
      let persisted = JSON.stringify({ 'legacy-secret-key': 'legacy-tab' });
      mockedReadFile.mockImplementation(async () => persisted as never);
      mockedWriteFile.mockImplementation(async (_path, value) => {
        persisted = String(value);
      });
      const alice = await createRouteTestHarness(registerSystemRoutes, {
        authUser: { username: 'alice', role: 'user' },
      });
      const bob = await createRouteTestHarness(registerSystemRoutes, {
        authUser: { username: 'bob', role: 'user' },
      });
      const admin = await createRouteTestHarness(registerSystemRoutes, {
        authUser: { username: 'root', role: 'admin' },
      });
      try {
        await alice.app.inject({
          method: 'PUT',
          url: '/api/subagent-parents',
          payload: { 'alice-key': 'alice-tab' },
        });
        expect(JSON.parse((await bob.app.inject({ method: 'GET', url: '/api/subagent-parents' })).body)).toEqual({});
        expect(JSON.parse((await alice.app.inject({ method: 'GET', url: '/api/subagent-parents' })).body)).toEqual({
          'alice-key': 'alice-tab',
        });
        expect(JSON.parse((await admin.app.inject({ method: 'GET', url: '/api/subagent-parents' })).body)).toEqual({
          'legacy-secret-key': 'legacy-tab',
        });
      } finally {
        await Promise.all([alice.app.close(), bob.app.close(), admin.app.close()]);
        if (priorMode === undefined) delete process.env.CODEMAN_MULTIUSER;
        else process.env.CODEMAN_MULTIUSER = priorMode;
      }
    });

    it('saves valid parent map', async () => {
      const res = await harness.app.inject({
        method: 'PUT',
        url: '/api/subagent-parents',
        payload: { 'agent-1': 'session-abc' },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({});
      expect(mockedWriteFile).toHaveBeenCalled();
    });

    it('accepts empty parent map', async () => {
      const res = await harness.app.inject({
        method: 'PUT',
        url: '/api/subagent-parents',
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({});
    });

    it('rejects non-string values in parent map', async () => {
      const res = await harness.app.inject({
        method: 'PUT',
        url: '/api/subagent-parents',
        payload: { 'agent-1': 123 },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.message ?? body.error).toBeTruthy();
    });
  });

  // ========== GET /api/screenshots ==========

  describe('GET /api/screenshots', () => {
    it('returns empty list when directory does not exist', async () => {
      mockedExistsSync.mockReturnValue(false);

      const res = await harness.app.inject({ method: 'GET', url: '/api/screenshots' });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ files: [] });
    });

    it('returns image files sorted in reverse order', async () => {
      mockedExistsSync.mockReturnValue(true);
      mockedReaddirSync.mockReturnValue([
        'screenshot_2026-01-01_00-00-00.png',
        'screenshot_2026-01-02_00-00-00.png',
        'not-an-image.txt',
        'screenshot_2026-01-03_00-00-00.jpg',
      ] as never);

      const res = await harness.app.inject({ method: 'GET', url: '/api/screenshots' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.files).toHaveLength(3); // excludes .txt
      // Sorted reverse: 03, 02, 01
      expect(body.files[0].name).toBe('screenshot_2026-01-03_00-00-00.jpg');
      expect(body.files[1].name).toBe('screenshot_2026-01-02_00-00-00.png');
      expect(body.files[2].name).toBe('screenshot_2026-01-01_00-00-00.png');
    });
  });

  describe('/api/screenshots deprecation', () => {
    it('warns once across requests and leaves the response unchanged', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        mockedExistsSync.mockReturnValue(false);
        const first = await harness.app.inject({ method: 'GET', url: '/api/screenshots' });
        const second = await harness.app.inject({ method: 'GET', url: '/api/screenshots' });
        expect(JSON.parse(first.body)).toEqual({ files: [] });
        expect(JSON.parse(second.body)).toEqual({ files: [] });
        const deprecations = warn.mock.calls.filter((c) => String(c[0]).includes('/api/screenshots'));
        expect(deprecations).toHaveLength(1);
        expect(String(deprecations[0][0])).toContain('POST /api/sessions/:id/paste-image');
      } finally {
        warn.mockRestore();
      }
    });

    // One request per route on the fresh per-test harness, so each warn call is pinned on its own
    // (the once-flag would let the first route's warning mask a missing call on the others).
    it.each([
      { label: 'GET /api/screenshots', method: 'GET' as const, url: '/api/screenshots' },
      {
        label: 'POST /api/screenshots',
        method: 'POST' as const,
        url: '/api/screenshots',
        payload: { file: 'data' },
        headers: { 'content-type': 'application/json' },
      },
      { label: 'GET /api/screenshots/:name', method: 'GET' as const, url: '/api/screenshots/nonexistent.png' },
    ])('$label warns that it is deprecated', async ({ method, url, payload, headers }) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        mockedExistsSync.mockReturnValue(false);
        await harness.app.inject({ method, url, payload, headers });
        const deprecations = warn.mock.calls.filter((c) => String(c[0]).includes('/api/screenshots'));
        expect(deprecations).toHaveLength(1);
        expect(String(deprecations[0][0])).toContain('POST /api/sessions/:id/paste-image');
      } finally {
        warn.mockRestore();
      }
    });
  });

  // ========== GET /api/screenshots/:name ==========

  describe('GET /api/screenshots/:name', () => {
    it('rejects path traversal attempts', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/screenshots/..%2F..%2Fetc%2Fpasswd',
      });
      expect(res.statusCode).toBe(400);
    });

    it('returns 404 when screenshot does not exist', async () => {
      mockedExistsSync.mockReturnValue(false);

      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/screenshots/nonexistent.png',
      });
      expect(res.statusCode).toBe(404);
    });

    it('serves existing screenshot with correct content type', async () => {
      mockedExistsSync.mockReturnValue(true);
      mockedReadFile.mockResolvedValue(Buffer.from('fake-png-data') as never);

      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/screenshots/test-image.png',
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('image/png');
    });

    it('serves jpeg with correct content type', async () => {
      mockedExistsSync.mockReturnValue(true);
      mockedReadFile.mockResolvedValue(Buffer.from('fake-jpg-data') as never);

      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/screenshots/photo.jpg',
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('image/jpeg');
    });
  });

  // ========== POST /api/screenshots ==========

  describe('POST /api/screenshots', () => {
    it('rejects non-multipart content type', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/screenshots',
        payload: { file: 'data' },
        headers: { 'content-type': 'application/json' },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.error).toContain('multipart');
    });
  });

  // ========== GET /api/session-lifecycle ==========

  describe('GET /api/session-lifecycle', () => {
    it('returns lifecycle entries', async () => {
      const mockEntries = [{ event: 'session_created', sessionId: 'test-1', timestamp: Date.now() }];
      mockedGetLifecycleLog.mockReturnValue({
        log: vi.fn(),
        query: vi.fn(async () => mockEntries),
      } as never);

      const res = await harness.app.inject({ method: 'GET', url: '/api/session-lifecycle' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.entries).toEqual(mockEntries);
    });

    it('passes filter query params to lifecycle log', async () => {
      const queryFn = vi.fn(async () => []);
      mockedGetLifecycleLog.mockReturnValue({
        log: vi.fn(),
        query: queryFn,
      } as never);

      await harness.app.inject({
        method: 'GET',
        url: '/api/session-lifecycle?sessionId=s1&event=session_created&since=1000&limit=50',
      });

      expect(queryFn).toHaveBeenCalledWith({
        sessionId: 's1',
        event: 'session_created',
        since: 1000,
        limit: 50,
      });
    });

    it('caps limit at 1000', async () => {
      const queryFn = vi.fn(async () => []);
      mockedGetLifecycleLog.mockReturnValue({
        log: vi.fn(),
        query: queryFn,
      } as never);

      await harness.app.inject({
        method: 'GET',
        url: '/api/session-lifecycle?limit=5000',
      });

      expect(queryFn).toHaveBeenCalledWith(expect.objectContaining({ limit: 1000 }));
    });

    it('defaults limit to 200 when not specified', async () => {
      const queryFn = vi.fn(async () => []);
      mockedGetLifecycleLog.mockReturnValue({
        log: vi.fn(),
        query: queryFn,
      } as never);

      await harness.app.inject({ method: 'GET', url: '/api/session-lifecycle' });

      expect(queryFn).toHaveBeenCalledWith(expect.objectContaining({ limit: 200 }));
    });
  });

  // ========== GET /api/:agent/status ==========

  describe('CLI status routes', () => {
    const agents = [
      ['claude', mockedFindClaudeDir, 'Claude resolver diagnostic'],
      ['opencode', mockedResolveOpenCodeDir, 'OpenCode resolver diagnostic'],
      ['codex', mockedResolveCodexDir, 'Codex resolver diagnostic'],
      ['gemini', mockedResolveGeminiDir, 'Gemini resolver diagnostic'],
      ['antigravity', mockedResolveAntigravityDir, 'Antigravity resolver diagnostic'],
      ['pi', mockedResolvePiDir, 'Pi resolver diagnostic'],
    ] as const;

    it.each(agents)('returns the %s resolver diagnostic when unavailable', async (agent, resolveDir, diagnostic) => {
      resolveDir.mockReturnValue(null);

      const res = await harness.app.inject({ method: 'GET', url: `/api/${agent}/status` });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({
        available: false,
        path: null,
        ...(agent === 'pi' ? { version: null } : {}),
        error: diagnostic,
      });
      expect(resolveDir).toHaveBeenCalledTimes(1);
      if (agent === 'pi') expect(mockedGetPiCliVersion).not.toHaveBeenCalled();
    });

    it.each(agents)('omits error from the %s status when available', async (agent, resolveDir) => {
      resolveDir.mockReturnValue('/usr/local/bin');
      if (agent === 'pi') mockedGetPiCliVersion.mockReturnValue('0.84.1');

      const res = await harness.app.inject({ method: 'GET', url: `/api/${agent}/status` });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({
        available: true,
        path: '/usr/local/bin',
        ...(agent === 'pi' ? { version: '0.84.1' } : {}),
      });
      expect(resolveDir).toHaveBeenCalledTimes(1);
    });

    it('keeps the legacy agy alias coherent when Antigravity is unavailable', async () => {
      mockedResolveAntigravityDir.mockReturnValue(null);

      const res = await harness.app.inject({ method: 'GET', url: '/api/agy/status' });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({
        available: false,
        path: null,
        error: 'Antigravity resolver diagnostic',
      });
      expect(mockedResolveAntigravityDir).toHaveBeenCalledTimes(1);
    });

    it('keeps the legacy agy alias coherent when Antigravity is available', async () => {
      mockedResolveAntigravityDir.mockReturnValue('/usr/local/bin');

      const res = await harness.app.inject({ method: 'GET', url: '/api/agy/status' });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ available: true, path: '/usr/local/bin' });
      expect(mockedResolveAntigravityDir).toHaveBeenCalledTimes(1);
    });
  });

  // ========== GET /api/execution/model-config ==========

  describe('GET /api/execution/model-config', () => {
    it('returns empty data when settings file does not exist', async () => {
      mockedReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

      const res = await harness.app.inject({ method: 'GET', url: '/api/execution/model-config' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data).toEqual({});
    });

    it('returns model config from settings', async () => {
      const settings = { modelConfig: { model: 'claude-3', temperature: 0.7 } };
      mockedReadFile.mockResolvedValue(JSON.stringify(settings) as never);

      const res = await harness.app.inject({ method: 'GET', url: '/api/execution/model-config' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data).toEqual(settings.modelConfig);
    });

    it('returns empty data when settings has no modelConfig', async () => {
      mockedReadFile.mockResolvedValue(JSON.stringify({ showCost: true }) as never);

      const res = await harness.app.inject({ method: 'GET', url: '/api/execution/model-config' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data).toEqual({});
    });
  });

  // ========== PUT /api/execution/model-config ==========

  describe('PUT /api/execution/model-config', () => {
    it('saves valid model config', async () => {
      mockedReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

      const res = await harness.app.inject({
        method: 'PUT',
        url: '/api/execution/model-config',
        payload: { model: 'claude-3', temperature: 0.5 },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({});
      expect(mockedWriteFile).toHaveBeenCalled();

      // Verify the written content contains modelConfig
      const writtenContent = JSON.parse(mockedWriteFile.mock.calls[0][1] as string);
      expect(writtenContent.modelConfig).toEqual({ model: 'claude-3', temperature: 0.5 });
    });

    it('preserves existing settings when updating model config', async () => {
      mockedReadFile.mockResolvedValue(JSON.stringify({ showCost: true, other: 'value' }) as never);

      const res = await harness.app.inject({
        method: 'PUT',
        url: '/api/execution/model-config',
        payload: { model: 'new-model' },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({});

      const writtenContent = JSON.parse(mockedWriteFile.mock.calls[0][1] as string);
      expect(writtenContent.showCost).toBe(true);
      expect(writtenContent.other).toBe('value');
      expect(writtenContent.modelConfig).toEqual({ model: 'new-model' });
    });
  });

  // ========== GET /api/subagents/:agentId ==========

  describe('GET /api/subagents/:agentId', () => {
    it('returns 200 with error for unknown agent', async () => {
      mockedSubagentWatcher.getSubagent.mockReturnValue(null);

      const res = await harness.app.inject({ method: 'GET', url: '/api/subagents/unknown-agent' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.error).toContain('not found');
    });

    it('returns agent info for known agent', async () => {
      const agentInfo = { agentId: 'agent-1', status: 'active', pid: 1234 };
      mockedSubagentWatcher.getSubagent.mockReturnValue(agentInfo as never);

      const res = await harness.app.inject({ method: 'GET', url: '/api/subagents/agent-1' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data).toEqual(agentInfo);
    });

    it('uses an opaque composite key for metadata lookup', async () => {
      mockedSubagentWatcher.resolveSubagentReference.mockReturnValue({
        status: 'found',
        info: { agentKey: 'v1.opaque', agentId: 'same', sessionId: 'conversation-a' },
      } as never);

      const res = await harness.app.inject({ method: 'GET', url: '/api/subagents/v1.opaque' });

      expect(res.statusCode).toBe(200);
      expect(mockedSubagentWatcher.resolveSubagentReference).toHaveBeenCalledWith('v1.opaque');
    });

    it('rejects an ambiguous legacy bare ID', async () => {
      mockedSubagentWatcher.resolveSubagentReference.mockReturnValue({ status: 'ambiguous' } as never);

      const res = await harness.app.inject({ method: 'GET', url: '/api/subagents/shared' });

      expect(JSON.parse(res.body)).toMatchObject({ success: false, errorCode: 'CONFLICT' });
    });
  });

  // ========== GET /api/subagents/:agentId/transcript ==========

  describe('GET /api/subagents/:agentId/transcript', () => {
    it('returns raw transcript by default', async () => {
      const transcript = [{ role: 'assistant', content: 'hello' }];
      mockedSubagentWatcher.getTranscript.mockResolvedValue(transcript as never);

      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/subagents/agent-1/transcript',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data).toEqual(transcript);
    });

    it('returns formatted transcript when format=formatted', async () => {
      const transcript = [{ role: 'assistant', content: 'hello' }];
      mockedSubagentWatcher.getTranscript.mockResolvedValue(transcript as never);
      mockedSubagentWatcher.formatTranscript.mockReturnValue('## Formatted\nhello');

      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/subagents/agent-1/transcript?format=formatted',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.formatted).toBe('## Formatted\nhello');
      expect(body.data.entryCount).toBe(1);
    });

    it('passes limit parameter', async () => {
      mockedSubagentWatcher.getTranscript.mockResolvedValue([] as never);

      await harness.app.inject({
        method: 'GET',
        url: '/api/subagents/agent-1/transcript?limit=10',
      });
      expect(mockedSubagentWatcher.getTranscript).toHaveBeenCalledWith('agent-1', 10);
    });

    it('resolves opaque and unambiguous legacy references before transcript reads', async () => {
      mockedSubagentWatcher.resolveSubagentReference.mockReturnValue({
        status: 'found',
        info: { agentKey: 'v1.exact', agentId: 'same' },
      } as never);

      await harness.app.inject({ method: 'GET', url: '/api/subagents/v1.exact/transcript' });

      expect(mockedSubagentWatcher.getTranscript).toHaveBeenCalledWith('v1.exact', undefined);
    });

    it('rejects an ambiguous legacy transcript reference', async () => {
      mockedSubagentWatcher.resolveSubagentReference.mockReturnValue({ status: 'ambiguous' } as never);

      const res = await harness.app.inject({ method: 'GET', url: '/api/subagents/shared/transcript' });

      expect(JSON.parse(res.body)).toMatchObject({ success: false, errorCode: 'CONFLICT' });
      expect(mockedSubagentWatcher.getTranscript).not.toHaveBeenCalled();
    });
  });

  // ========== DELETE /api/subagents/:agentId ==========

  describe('DELETE /api/subagents/:agentId', () => {
    it('returns error for unknown agent', async () => {
      mockedSubagentWatcher.getSubagent.mockReturnValue(null);

      const res = await harness.app.inject({ method: 'DELETE', url: '/api/subagents/unknown' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.error).toContain('not found');
    });

    it('kills a known agent successfully', async () => {
      mockedSubagentWatcher.getSubagent.mockReturnValue({ agentId: 'agent-1' } as never);
      mockedSubagentWatcher.killSubagent.mockResolvedValue({ status: 'killed', agentKey: 'agent-1' });

      const res = await harness.app.inject({ method: 'DELETE', url: '/api/subagents/agent-1' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.status).toBe('killed');
    });

    it('kills only the opaque composite record selected by the route', async () => {
      mockedSubagentWatcher.resolveSubagentReference.mockReturnValue({
        status: 'found',
        info: { agentKey: 'v1.exact', agentId: 'same', sessionId: 'conversation-a' },
      } as never);
      mockedSubagentWatcher.killSubagent.mockResolvedValue({ status: 'killed', agentKey: 'v1.exact' });

      const res = await harness.app.inject({ method: 'DELETE', url: '/api/subagents/v1.exact' });

      expect(mockedSubagentWatcher.killSubagent).toHaveBeenCalledWith('v1.exact');
      expect(JSON.parse(res.body).data).toEqual({
        agentKey: 'v1.exact',
        agentId: 'same',
        status: 'killed',
      });
    });

    it('preserves an unambiguous legacy bare-ID kill fallback', async () => {
      mockedSubagentWatcher.resolveSubagentReference.mockReturnValue({
        status: 'found',
        info: { agentKey: 'v1.only', agentId: 'legacy' },
      } as never);
      mockedSubagentWatcher.killSubagent.mockResolvedValue({ status: 'killed', agentKey: 'v1.only' });

      await harness.app.inject({ method: 'DELETE', url: '/api/subagents/legacy' });

      expect(mockedSubagentWatcher.killSubagent).toHaveBeenCalledWith('v1.only');
    });

    it('rejects an ambiguous legacy bare-ID kill', async () => {
      mockedSubagentWatcher.resolveSubagentReference.mockReturnValue({ status: 'ambiguous' } as never);

      const res = await harness.app.inject({ method: 'DELETE', url: '/api/subagents/shared' });

      expect(JSON.parse(res.body)).toMatchObject({ success: false, errorCode: 'CONFLICT' });
      expect(mockedSubagentWatcher.killSubagent).not.toHaveBeenCalled();
    });

    it('returns error when kill fails', async () => {
      mockedSubagentWatcher.getSubagent.mockReturnValue({ agentId: 'agent-1' } as never);
      mockedSubagentWatcher.killSubagent.mockResolvedValue({ status: 'already_completed' });

      const res = await harness.app.inject({ method: 'DELETE', url: '/api/subagents/agent-1' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.error).toContain('already completed');
    });

    it('returns a typed safe failure when exact termination is unsupported', async () => {
      mockedSubagentWatcher.getSubagent.mockReturnValue({ agentKey: 'v1.agent', agentId: 'agent-1' } as never);
      mockedSubagentWatcher.killSubagent.mockResolvedValue({ status: 'atomic_termination_unavailable' });

      const res = await harness.app.inject({ method: 'DELETE', url: '/api/subagents/agent-1' });

      expect(JSON.parse(res.body)).toMatchObject({
        success: false,
        reason: 'atomic_termination_unavailable',
        error: expect.stringContaining('unavailable'),
      });
    });
  });

  // ========== POST /api/subagents/cleanup ==========

  describe('POST /api/subagents/cleanup', () => {
    it('triggers cleanup and returns count', async () => {
      mockedSubagentWatcher.cleanupNow.mockReturnValue(3);
      mockedSubagentWatcher.getSubagents.mockReturnValue([{ agentId: 'a' }, { agentId: 'b' }] as never);

      const res = await harness.app.inject({ method: 'POST', url: '/api/subagents/cleanup' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.removed).toBe(3);
      expect(body.data.remaining).toBe(2);
    });
  });

  // ========== DELETE /api/subagents ==========

  describe('DELETE /api/subagents', () => {
    it('clears all subagents', async () => {
      mockedSubagentWatcher.clearAll.mockReturnValue(5);

      const res = await harness.app.inject({ method: 'DELETE', url: '/api/subagents' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.cleared).toBe(5);
    });

    it('returns the canonical remaining live-agent snapshot after clearing history', async () => {
      const live = [{ agentKey: 'v1.live', agentId: 'live', status: 'idle' }];
      mockedSubagentWatcher.clearAll.mockReturnValue(2);
      mockedSubagentWatcher.getSubagents.mockReturnValue(live as never);

      const res = await harness.app.inject({ method: 'DELETE', url: '/api/subagents' });

      expect(JSON.parse(res.body).data).toEqual({ cleared: 2, remaining: live });
    });
  });

  // ========== GET /api/sessions/:id/subagents ==========

  describe('GET /api/sessions/:id/subagents', () => {
    it('returns 404 for unknown session', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/sessions/nonexistent/subagents',
      });
      expect(res.statusCode).toBe(404);
    });

    it('returns subagents for valid session', async () => {
      Object.defineProperty(harness.ctx._session, 'claudeSessionId', { value: 'conversation-a', configurable: true });
      mockedSubagentWatcher.getSubagentsForConversation.mockReturnValue([
        { agentKey: 'v1.exact', agentId: 'sub-1', sessionId: 'conversation-a', status: 'active' },
      ] as never);

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/subagents`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data).toHaveLength(1);
      expect(mockedSubagentWatcher.getSubagentsForConversation).toHaveBeenCalledWith(
        harness.ctx._session.workingDir,
        'conversation-a'
      );
    });
  });

  // ========== POST /api/tunnel/qr/regenerate ==========

  describe('POST /api/tunnel/qr/regenerate', () => {
    it('calls regenerateQrToken on tunnel manager', async () => {
      // Set up a mock tunnel manager
      harness.ctx.tunnelManager = {
        regenerateQrToken: vi.fn(),
        getStatus: vi.fn(() => ({ running: false })),
        getUrl: vi.fn(() => null),
        getQrSvg: vi.fn(),
        consumeToken: vi.fn(),
        isRunning: vi.fn(() => false),
        start: vi.fn(),
        stop: vi.fn(),
      } as never;

      // Re-create the harness since tunnelManager was null originally
      await harness.app.close();
      harness = await createRouteTestHarness(registerSystemRoutes);
      harness.ctx.tunnelManager = {
        regenerateQrToken: vi.fn(),
        getStatus: vi.fn(() => ({ running: false })),
        getUrl: vi.fn(() => null),
        getQrSvg: vi.fn(),
        consumeToken: vi.fn(),
        isRunning: vi.fn(() => false),
        start: vi.fn(),
        stop: vi.fn(),
      } as never;

      const res = await harness.app.inject({ method: 'POST', url: '/api/tunnel/qr/regenerate' });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({});
    });
  });
});
