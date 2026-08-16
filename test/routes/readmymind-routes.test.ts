/**
 * @fileoverview Read My Mind route tests (src/web/routes/readmymind-routes.ts)
 * via app.inject(), no live port.
 *
 * The routes read the process-wide `intentStore` singleton, whose data file
 * resolves under this test file's temp HOME (test/setup.ts). The singleton's
 * in-memory map lives for the whole file, so each test uses a distinct
 * session workingDir to stay isolated.
 *
 * The predictor singleton is stubbed (`vi.spyOn(readMyMindPredictor,
 * 'predict')`): nothing here ever spawns tmux or the claude CLI.
 *
 * Port: SessionPort & ConfigPort & InfraPort.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { registerReadMyMindRoutes } from '../../src/web/routes/readmymind-routes.js';
import { readMyMindPredictor, type PredictionResult } from '../../src/readmymind-predictor.js';
import * as codexIdentity from '../../src/checkpoint-conversation-identity.js';
import * as codexRolloutReader from '../../src/codex-rollout-reader.js';
import { resolveReadMyMindCodexHome } from '../../src/web/routes/readmymind-routes.js';
import { intentStore } from '../../src/intent-store.js';
import { MockSession } from '../mocks/mock-session.js';
import { createRouteTestHarness, type RouteTestHarness } from './_route-test-utils.js';

const SESSION_ID = 'test-session-1';

let harness: RouteTestHarness;
let caseCounter = 0;

beforeEach(async () => {
  harness = await createRouteTestHarness(registerReadMyMindRoutes);
  // Unique (nonexistent) workingDir per test: resolveDir falls back to the raw
  // string, so the key is stable and no other test's profile bleeds in.
  caseCounter++;
  sessionUnderTest().workingDir = `/nonexistent/readmymind-case-${caseCounter}`;
});

afterEach(async () => {
  await harness.app.close();
});

function sessionUnderTest(): MockSession {
  return harness.ctx.sessions.get(SESSION_ID)!;
}

describe('GET /api/sessions/:id/intent', () => {
  it('returns an empty transient profile for a fresh case', async () => {
    const res = await harness.app.inject({ method: 'GET', url: `/api/sessions/${SESSION_ID}/intent` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.data.intent.goals).toBe('');
    expect(body.data.intent.recentPrompts).toEqual([]);
    expect(body.data.intent.updatedAt).toBe(0);
  });

  it('404s an unknown session id', async () => {
    const res = await harness.app.inject({ method: 'GET', url: '/api/sessions/nope/intent' });
    expect(res.statusCode).toBe(404);
    expect(res.json().success).toBe(false);
  });
});

describe('PUT /api/sessions/:id/intent', () => {
  it('round-trips goals through the store', async () => {
    const put = await harness.app.inject({
      method: 'PUT',
      url: `/api/sessions/${SESSION_ID}/intent`,
      payload: { goals: 'ship 1.17 with the readmymind phase 1' },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().data.intent.goals).toBe('ship 1.17 with the readmymind phase 1');
    expect(put.json().data.intent.updatedAt).toBeGreaterThan(0);

    const get = await harness.app.inject({ method: 'GET', url: `/api/sessions/${SESSION_ID}/intent` });
    expect(get.json().data.intent.goals).toBe('ship 1.17 with the readmymind phase 1');
  });

  it('rejects over-long goals and unknown keys (strict schema)', async () => {
    const tooLong = await harness.app.inject({
      method: 'PUT',
      url: `/api/sessions/${SESSION_ID}/intent`,
      payload: { goals: 'x'.repeat(8193) },
    });
    expect(tooLong.statusCode).toBe(400);

    const extraKey = await harness.app.inject({
      method: 'PUT',
      url: `/api/sessions/${SESSION_ID}/intent`,
      payload: { goals: 'ok', recentPrompts: [] },
    });
    expect(extraKey.statusCode).toBe(400);
  });
});

describe('DELETE /api/sessions/:id/intent', () => {
  it('forgets the case and reports whether anything existed', async () => {
    await harness.app.inject({
      method: 'PUT',
      url: `/api/sessions/${SESSION_ID}/intent`,
      payload: { goals: 'temporary' },
    });

    const first = await harness.app.inject({ method: 'DELETE', url: `/api/sessions/${SESSION_ID}/intent` });
    expect(first.statusCode).toBe(200);
    expect(first.json().data.deleted).toBe(true);

    const second = await harness.app.inject({ method: 'DELETE', url: `/api/sessions/${SESSION_ID}/intent` });
    expect(second.json().data.deleted).toBe(false);

    const get = await harness.app.inject({ method: 'GET', url: `/api/sessions/${SESSION_ID}/intent` });
    expect(get.json().data.intent.goals).toBe('');
  });
});

describe('POST /api/sessions/:id/readmymind', () => {
  const RESULT: PredictionResult = {
    suggestions: [{ prompt: 'run the tests', why: 'a fix just landed', kind: 'verify' }],
    durationMs: 1234,
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the stubbed suggestions and feeds user signals into the prompt', async () => {
    const predict = vi.spyOn(readMyMindPredictor, 'predict').mockResolvedValue(RESULT);
    const resolveCodex = vi.spyOn(codexIdentity, 'findOwnedCodexConversation');
    const readCodex = vi.spyOn(codexRolloutReader, 'readCodexRolloutSignals');
    const codexEnvironment = vi.spyOn(sessionUnderTest(), 'getCodexProviderEnvironment');
    await harness.app.inject({
      method: 'PUT',
      url: `/api/sessions/${SESSION_ID}/intent`,
      payload: { goals: 'GOALS_MARKER ship the release' },
    });

    const res = await harness.app.inject({ method: 'POST', url: `/api/sessions/${SESSION_ID}/readmymind` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.data.suggestions).toEqual(RESULT.suggestions);
    expect(body.data.durationMs).toBe(1234);

    expect(predict).toHaveBeenCalledTimes(1);
    const options = predict.mock.calls[0][0];
    expect(options.sessionId).toBe(SESSION_ID);
    expect(options.provider).toEqual({ kind: 'claude', model: 'claude-opus-4-5-20251101' });
    expect(options.prompt).toContain('TRUST TIERS');
    expect(options.prompt).toContain('GOALS_MARKER');
    expect(harness.ctx.getReadMyMindModel).toHaveBeenCalledTimes(1);
    expect(codexEnvironment).not.toHaveBeenCalled();
    expect(resolveCodex).not.toHaveBeenCalled();
    expect(readCodex).not.toHaveBeenCalled();
  });

  it('accepts local Codex with its session-selected model and closed provider environment', async () => {
    const predict = vi.spyOn(readMyMindPredictor, 'predict').mockResolvedValue(RESULT);
    vi.spyOn(codexIdentity, 'findOwnedCodexConversation').mockResolvedValue(undefined);
    const session = sessionUnderTest();
    session.mode = 'codex';
    session.codexConfig = { model: 'gpt-5.4', resumeSessionId: 'resume-id' };
    session.getCodexProviderEnvironment.mockReturnValue({
      CODEX_HOME: '/tmp/codex-home',
      OPENAI_API_KEY: 'session-key',
    });
    session.getCodexHomeOverride.mockReturnValue('/tmp/codex-home');

    const res = await harness.app.inject({ method: 'POST', url: `/api/sessions/${SESSION_ID}/readmymind` });

    expect(res.statusCode).toBe(200);
    expect(predict).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: SESSION_ID,
        provider: {
          kind: 'codex',
          model: 'gpt-5.4',
          env: { CODEX_HOME: '/tmp/codex-home', OPENAI_API_KEY: 'session-key' },
        },
      })
    );
    expect(harness.ctx.getReadMyMindModel).not.toHaveBeenCalled();
  });

  it('uses Codex home precedence without copying process credentials into the session environment', () => {
    expect(
      resolveReadMyMindCodexHome(
        { CODEX_HOME: '/session/home' },
        { CODEX_HOME: '/process/home', HOME: '/process/user' }
      )
    ).toBe('/session/home');
    expect(resolveReadMyMindCodexHome({}, { CODEX_HOME: '/process/home', HOME: '/process/user' })).toBe(
      '/process/home'
    );
    expect(resolveReadMyMindCodexHome({}, { HOME: '/process/user' })).toBe('/process/user/.codex');
    expect(resolveReadMyMindCodexHome({}, {})).toBe(join(tmpdir(), '.codex'));
  });

  it('passes pane identity inputs to the resolver and feeds owned rollout signals into context', async () => {
    const predict = vi.spyOn(readMyMindPredictor, 'predict').mockResolvedValue(RESULT);
    const resolveCodex = vi
      .spyOn(codexIdentity, 'findOwnedCodexConversation')
      .mockResolvedValue({ id: 'owned-rollout', path: '/resolved/owned.jsonl' });
    vi.spyOn(codexRolloutReader, 'readCodexRolloutSignals').mockResolvedValue({
      lastAssistantText: 'OWNED_ASSISTANT_MARKER',
      recentPrompts: [
        { text: 'ROLLOUT_PROMPT_MARKER\ncontinued', timestamp: '2026-08-16T14:00:00.000Z' },
        { text: 'missing timestamp prompt' },
      ],
      recentTools: [{ name: 'exec_command', detail: 'OWNED_TOOL_MARKER' }],
    });
    const session = sessionUnderTest();
    session.mode = 'codex';
    session.workingDir = '/tmp/readmymind-owned-workdir';
    session.codexConfig = { model: 'gpt-5.4', resumeSessionId: 'resume-id' };
    session.lastSubmitAt = 11_000;
    session.getCodexProviderEnvironment.mockReturnValue({ CODEX_HOME: '/session/codex-home' });
    session.getCodexHomeOverride.mockReturnValue('/session/codex-home');
    const sibling = new MockSession('competing-pane');
    sibling.mode = 'codex';
    sibling.lastSubmitAt = 11_000;
    sibling.getCodexHomeOverride.mockReturnValue('/session/./codex-home');
    harness.ctx.sessions.set(sibling.id, sibling);
    const differentHome = new MockSession('different-home-pane');
    differentHome.mode = 'codex';
    differentHome.lastSubmitAt = 13_000;
    differentHome.getCodexHomeOverride.mockReturnValue('/different/codex-home');
    harness.ctx.sessions.set(differentHome.id, differentHome);
    const remoteSibling = new MockSession('remote-pane');
    remoteSibling.mode = 'codex';
    remoteSibling.lastSubmitAt = 14_000;
    remoteSibling.remote = { hostId: 'remote', label: 'remote', host: 'example.test', remotePath: '/work' };
    remoteSibling.getCodexHomeOverride.mockReturnValue('/session/codex-home');
    harness.ctx.sessions.set(remoteSibling.id, remoteSibling);
    const dockerSibling = new MockSession('docker-pane') as MockSession & { docker?: { containerName: string } };
    dockerSibling.mode = 'codex';
    dockerSibling.lastSubmitAt = 15_000;
    dockerSibling.docker = { containerName: 'codex-container' };
    dockerSibling.getCodexHomeOverride.mockReturnValue('/session/codex-home');
    harness.ctx.sessions.set(dockerSibling.id, dockerSibling);
    const before = Date.parse('2026-08-16T13:59:59.000Z');
    const after = Date.parse('2026-08-16T14:00:01.000Z');
    harness.ctx.runSummaryTrackers.set(SESSION_ID, {
      getRecentEvents: vi.fn(() => [
        { timestamp: before, title: 'BEFORE_MARKER' },
        { timestamp: after, title: 'AFTER_MARKER' },
      ]),
    } as never);
    intentStore.recordPrompt(session.owner, session.workingDir, session.id, 'INTENT_PROMPT_MARKER', 1_000);

    const res = await harness.app.inject({ method: 'POST', url: `/api/sessions/${SESSION_ID}/readmymind` });

    expect(res.statusCode).toBe(200);
    expect(resolveCodex).toHaveBeenCalledWith({
      codexHome: '/session/codex-home',
      sessionId: SESSION_ID,
      workingDir: session.workingDir,
      resumeSessionId: 'resume-id',
      nativeResumeId: undefined,
      lastSubmitAt: 11_000,
      competingSubmitAts: [11_000],
    });
    expect(sibling.getCodexHomeOverride).toHaveBeenCalled();
    expect(differentHome.getCodexHomeOverride).toHaveBeenCalled();
    expect(remoteSibling.getCodexHomeOverride).not.toHaveBeenCalled();
    expect(dockerSibling.getCodexHomeOverride).not.toHaveBeenCalled();
    expect(sibling.getCodexProviderEnvironment).not.toHaveBeenCalled();
    expect(differentHome.getCodexProviderEnvironment).not.toHaveBeenCalled();
    const prompt = predict.mock.calls[0][0].prompt;
    expect(prompt).toContain('OWNED_ASSISTANT_MARKER');
    expect(prompt).toContain('ROLLOUT_PROMPT_MARKER continued');
    expect(prompt).toContain('INTENT_PROMPT_MARKER');
    expect(prompt).toContain('OWNED_TOOL_MARKER');
    expect(prompt).not.toContain('BEFORE_MARKER');
    expect(prompt).toContain('AFTER_MARKER');
    expect(intentStore.getProfile(session.owner, session.workingDir).recentPrompts).toEqual([
      expect.objectContaining({ text: 'INTENT_PROMPT_MARKER', ts: 1_000 }),
    ]);
  });

  it('fails closed instead of selecting a newer foreign Codex rollout', async () => {
    const codexHome = mkdtempSync(join(tmpdir(), 'readmymind-owned-rollout-'));
    const sessionsDir = join(codexHome, 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    const ownId = '11111111-1111-4111-8111-111111111111';
    const foreignId = '22222222-2222-4222-8222-222222222222';
    const row = (value: unknown) => `${JSON.stringify(value)}\n`;
    writeFileSync(
      join(sessionsDir, `rollout-own-${ownId}.jsonl`),
      row({ type: 'session_meta', payload: { originator: `codeman_${SESSION_ID}` } }) +
        row({
          timestamp: '2026-08-16T14:00:00.000Z',
          type: 'event_msg',
          payload: { type: 'user_message', message: 'OWN_PANE_PROMPT' },
        })
    );
    writeFileSync(
      join(sessionsDir, `rollout-foreign-${foreignId}.jsonl`),
      row({ type: 'session_meta', payload: { originator: 'codeman_some-other-pane' } }) +
        row({
          timestamp: '2026-08-16T14:01:00.000Z',
          type: 'event_msg',
          payload: { type: 'user_message', message: 'FOREIGN_PANE_PROMPT' },
        })
    );
    const predict = vi.spyOn(readMyMindPredictor, 'predict').mockResolvedValue(RESULT);
    const session = sessionUnderTest();
    session.mode = 'codex';
    session.getCodexProviderEnvironment.mockReturnValue({ CODEX_HOME: codexHome });
    session.getCodexHomeOverride.mockReturnValue(codexHome);
    try {
      const res = await harness.app.inject({ method: 'POST', url: `/api/sessions/${SESSION_ID}/readmymind` });
      expect(res.statusCode).toBe(200);
      expect(predict.mock.calls[0][0].prompt).toContain('OWN_PANE_PROMPT');
      expect(predict.mock.calls[0][0].prompt).not.toContain('FOREIGN_PANE_PROMPT');
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
    }
  });

  it('continues safely with no rollout signals when resolution or reading fails', async () => {
    const predict = vi.spyOn(readMyMindPredictor, 'predict').mockResolvedValue(RESULT);
    vi.spyOn(codexIdentity, 'findOwnedCodexConversation').mockRejectedValue(new Error('ambiguous rollout'));
    const session = sessionUnderTest();
    session.mode = 'codex';
    session.getCodexProviderEnvironment.mockReturnValue({ CODEX_HOME: '/missing/codex-home' });

    const res = await harness.app.inject({ method: 'POST', url: `/api/sessions/${SESSION_ID}/readmymind` });

    expect(res.statusCode).toBe(200);
    expect(predict).toHaveBeenCalledTimes(1);
  });

  it('threads steer and rejected suggestions into the rethink section', async () => {
    const predict = vi.spyOn(readMyMindPredictor, 'predict').mockResolvedValue(RESULT);
    const res = await harness.app.inject({
      method: 'POST',
      url: `/api/sessions/${SESSION_ID}/readmymind`,
      payload: { steer: 'STEER_MARKER the mobile bug', rejected: ['REJECTED_MARKER run the tests'] },
    });
    expect(res.statusCode).toBe(200);
    const prompt = predict.mock.calls[0][0].prompt;
    expect(prompt).toContain('STEER_MARKER');
    expect(prompt).toContain('REJECTED_MARKER');
  });

  it('409s while a prediction is already running for the session', async () => {
    let release: (value: PredictionResult) => void = () => {};
    // First call hangs until released; later calls resolve immediately.
    vi.spyOn(readMyMindPredictor, 'predict')
      .mockImplementationOnce(() => new Promise<PredictionResult>((resolve) => (release = resolve)))
      .mockResolvedValue(RESULT);

    const first = harness.app.inject({ method: 'POST', url: `/api/sessions/${SESSION_ID}/readmymind` });
    // Let the first request reach the in-flight registration.
    await vi.waitFor(() => expect(readMyMindPredictor.predict).toHaveBeenCalled());

    const second = await harness.app.inject({ method: 'POST', url: `/api/sessions/${SESSION_ID}/readmymind` });
    expect(second.statusCode).toBe(409);
    expect(second.json().errorCode).toBe('CONFLICT');

    release(RESULT);
    expect((await first).statusCode).toBe(200);

    // The slot frees once the prediction settles.
    const third = await harness.app.inject({ method: 'POST', url: `/api/sessions/${SESSION_ID}/readmymind` });
    expect(third.statusCode).toBe(200);
  });

  it.each([
    ['shell', undefined, undefined],
    ['codex', { hostId: 'remote-host', host: 'example.test' }, undefined],
    ['codex', undefined, { containerName: 'codex-container' }],
  ])('400s unsupported %s session placement', async (mode, remote, docker) => {
    vi.spyOn(readMyMindPredictor, 'predict').mockResolvedValue(RESULT);
    const session = sessionUnderTest() as MockSession & { remote?: unknown; docker?: unknown };
    session.mode = mode;
    session.remote = remote;
    session.docker = docker;
    const res = await harness.app.inject({ method: 'POST', url: `/api/sessions/${SESSION_ID}/readmymind` });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('Claude and local Codex');
    expect(readMyMindPredictor.predict).not.toHaveBeenCalled();
    expect(session.getCodexProviderEnvironment).not.toHaveBeenCalled();
  });

  it('502s a predictor failure with the clean error message', async () => {
    const resolveCodex = vi.spyOn(codexIdentity, 'findOwnedCodexConversation');
    const codexEnvironment = vi.spyOn(sessionUnderTest(), 'getCodexProviderEnvironment');
    vi.spyOn(readMyMindPredictor, 'predict').mockRejectedValue(new Error('Predictor returned malformed JSON'));
    const res = await harness.app.inject({ method: 'POST', url: `/api/sessions/${SESSION_ID}/readmymind` });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toContain('malformed JSON');
    expect(resolveCodex).not.toHaveBeenCalled();
    expect(codexEnvironment).not.toHaveBeenCalled();

    // The in-flight slot is released after a failure.
    vi.spyOn(readMyMindPredictor, 'predict').mockResolvedValue(RESULT);
    const retry = await harness.app.inject({ method: 'POST', url: `/api/sessions/${SESSION_ID}/readmymind` });
    expect(retry.statusCode).toBe(200);
  });

  it('preserves a Codex provider failure without consulting or falling back to Claude', async () => {
    vi.spyOn(codexIdentity, 'findOwnedCodexConversation').mockResolvedValue(undefined);
    vi.spyOn(readMyMindPredictor, 'predict').mockRejectedValue(
      new Error('Codex prediction failed; check Codex authentication or configuration.')
    );
    const session = sessionUnderTest();
    session.mode = 'codex';

    const res = await harness.app.inject({ method: 'POST', url: `/api/sessions/${SESSION_ID}/readmymind` });

    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe('Codex prediction failed; check Codex authentication or configuration.');
    expect(harness.ctx.getReadMyMindModel).not.toHaveBeenCalled();

    // Provider failure releases the same-session guard without switching lanes.
    vi.mocked(readMyMindPredictor.predict).mockResolvedValue(RESULT);
    const retry = await harness.app.inject({ method: 'POST', url: `/api/sessions/${SESSION_ID}/readmymind` });
    expect(retry.statusCode).toBe(200);
    expect(harness.ctx.getReadMyMindModel).not.toHaveBeenCalled();
  });

  it('fails restored sessions with lost scoped credentials before rollout or process fallback', async () => {
    const resolveCodex = vi.spyOn(codexIdentity, 'findOwnedCodexConversation');
    const predict = vi.spyOn(readMyMindPredictor, 'predict').mockResolvedValue(RESULT);
    const session = sessionUnderTest();
    session.mode = 'codex';
    session.hasLostCodexProviderCredentials.mockReturnValue(true);
    session.getCodexProviderEnvironment.mockReturnValue({ CODEX_HOME: '/restored/codex-home' });

    const res = await harness.app.inject({ method: 'POST', url: `/api/sessions/${SESSION_ID}/readmymind` });

    expect(res.statusCode).toBe(502);
    expect(res.json().error).toContain('recreate or restart');
    expect(resolveCodex).not.toHaveBeenCalled();
    expect(predict).not.toHaveBeenCalled();
    expect(harness.ctx.getReadMyMindModel).not.toHaveBeenCalled();
  });

  it('rejects unknown body keys (strict schema)', async () => {
    vi.spyOn(readMyMindPredictor, 'predict').mockResolvedValue(RESULT);
    const res = await harness.app.inject({
      method: 'POST',
      url: `/api/sessions/${SESSION_ID}/readmymind`,
      payload: { autoSend: true },
    });
    expect(res.statusCode).toBe(400);
    expect(readMyMindPredictor.predict).not.toHaveBeenCalled();
  });

  it('404s an unknown session id', async () => {
    vi.spyOn(readMyMindPredictor, 'predict').mockResolvedValue(RESULT);
    const res = await harness.app.inject({ method: 'POST', url: '/api/sessions/nope/readmymind' });
    expect(res.statusCode).toBe(404);
  });
});

describe('multi-user scoping', () => {
  let savedMultiuser: string | undefined;

  beforeEach(() => {
    savedMultiuser = process.env.CODEMAN_MULTIUSER;
    process.env.CODEMAN_MULTIUSER = '1';
  });

  afterEach(() => {
    if (savedMultiuser === undefined) delete process.env.CODEMAN_MULTIUSER;
    else process.env.CODEMAN_MULTIUSER = savedMultiuser;
  });

  it("404s (never 403s) another user's session", async () => {
    const scoped = await createRouteTestHarness(registerReadMyMindRoutes, {
      authUser: { username: 'bob', role: 'user' },
    });
    try {
      (scoped.ctx.sessions.get(SESSION_ID) as unknown as { owner?: string }).owner = 'alice';
      const res = await scoped.app.inject({ method: 'GET', url: `/api/sessions/${SESSION_ID}/intent` });
      expect(res.statusCode).toBe(404);
    } finally {
      await scoped.app.close();
    }
  });

  it('authorizes a Codex prediction before provider environment or rollout access', async () => {
    const scoped = await createRouteTestHarness(registerReadMyMindRoutes, {
      authUser: { username: 'bob', role: 'user' },
    });
    const resolveCodex = vi.spyOn(codexIdentity, 'findOwnedCodexConversation');
    try {
      const session = scoped.ctx.sessions.get(SESSION_ID)!;
      session.owner = 'alice';
      session.mode = 'codex';
      const res = await scoped.app.inject({ method: 'POST', url: `/api/sessions/${SESSION_ID}/readmymind` });
      expect(res.statusCode).toBe(404);
      expect(session.getCodexProviderEnvironment).not.toHaveBeenCalled();
      expect(resolveCodex).not.toHaveBeenCalled();
    } finally {
      await scoped.app.close();
    }
  });

  it('serves the owner normally', async () => {
    const scoped = await createRouteTestHarness(registerReadMyMindRoutes, {
      authUser: { username: 'bob', role: 'user' },
    });
    try {
      const session = scoped.ctx.sessions.get(SESSION_ID) as unknown as { owner?: string; workingDir: string };
      session.owner = 'bob';
      session.workingDir = `/nonexistent/readmymind-owned-${Date.now()}`;
      const res = await scoped.app.inject({ method: 'GET', url: `/api/sessions/${SESSION_ID}/intent` });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
    } finally {
      await scoped.app.close();
    }
  });
});
