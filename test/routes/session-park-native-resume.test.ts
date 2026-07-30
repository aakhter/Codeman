/**
 * COD-124 unit 2, Gap B — native external-CLI session-id capture at park time.
 *
 * At park time (never speculatively), for codex-mode sessions Codeman looks up
 * the newest matching rollout file under $CODEX_HOME/sessions (reusing the same
 * findActiveCodexFile() discovery logic that backs the codexLastResponse
 * endpoint) and stores the rollout UUID on the session as `nativeResumeId`, so
 * a later /resume can thread it into `codex resume <id>` (see
 * buildCodexCommand() in tmux-manager.ts). gemini/opencode/claude/shell have no
 * analogous on-disk "resume this exact conversation by id" mechanism wired
 * into their CLI builders, so capture must return null for them rather than
 * inventing a resume flag that doesn't exist.
 *
 * These tests exercise the REAL findActiveCodexFile()/captureNativeResumeId()
 * filesystem walk against an isolated temp $CODEX_HOME (no fs mocking) so the
 * discovery contract — originator-tagged session_meta line, .jsonl filename
 * ending in the rollout uuid — stays honest.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRouteTestHarness, type RouteTestHarness } from './_route-test-utils.js';
import { registerSessionRoutes } from '../../src/web/routes/session-routes.js';

describe('POST /api/sessions/:id/park — native resume id capture (COD-124 Gap B)', () => {
  let harness: RouteTestHarness;
  let codexHome: string;
  let prevCodexHome: string | undefined;

  beforeEach(async () => {
    harness = await createRouteTestHarness(registerSessionRoutes);
    prevCodexHome = process.env.CODEX_HOME;
    codexHome = mkdtempSync(join(tmpdir(), 'codeman-codex-home-'));
    process.env.CODEX_HOME = codexHome;
  });

  afterEach(() => {
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevCodexHome;
    rmSync(codexHome, { recursive: true, force: true });
  });

  /** Writes a fixture rollout file that findActiveCodexFile() will discover. */
  function writeRolloutFixture(uuid: string, opts: { originator: string; cwd: string }): void {
    const sessionsDir = join(codexHome, 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    const metaLine = JSON.stringify({
      type: 'session_meta',
      payload: { cwd: opts.cwd, originator: opts.originator, extra: 'x'.repeat(150) },
    });
    writeFileSync(join(sessionsDir, `rollout-2026-01-01T00-00-00-${uuid}.jsonl`), `${metaLine}\n`);
  }

  it('captures the rollout uuid as nativeResumeId when a matching codex rollout exists', async () => {
    const uuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    harness.ctx._session.mode = 'codex';
    writeRolloutFixture(uuid, {
      originator: `codeman_${harness.ctx._sessionId}`,
      cwd: harness.ctx._session.workingDir,
    });

    const res = await harness.app.inject({
      method: 'POST',
      url: `/api/sessions/${harness.ctx._sessionId}/park`,
    });

    expect(res.statusCode).toBe(200);
    expect(harness.ctx._session.setNativeResumeId).toHaveBeenCalledWith(uuid);
    expect(harness.ctx._session.nativeResumeId).toBe(uuid);
    expect(harness.ctx._session.park).toHaveBeenCalledTimes(1);
  });

  it('captures null (and does not throw) when codex mode has no matching rollout file', async () => {
    harness.ctx._session.mode = 'codex';
    // No fixture written — sessions dir is empty.

    const res = await harness.app.inject({
      method: 'POST',
      url: `/api/sessions/${harness.ctx._sessionId}/park`,
    });

    expect(res.statusCode).toBe(200);
    expect(harness.ctx._session.setNativeResumeId).toHaveBeenCalledWith(null);
    expect(harness.ctx._session.nativeResumeId).toBeNull();
    expect(harness.ctx._session.park).toHaveBeenCalledTimes(1);
  });

  it.each(['claude', 'gemini', 'opencode', 'shell'])(
    'captures null for non-codex mode %s even when a rollout file happens to exist',
    async (mode) => {
      harness.ctx._session.mode = mode;
      // Even if a codex-shaped rollout exists on disk, non-codex modes must not
      // pick it up — codex is the only CLI with a real resume-by-id mechanism.
      writeRolloutFixture('ffffffff-1111-2222-3333-444444444444', {
        originator: `codeman_${harness.ctx._sessionId}`,
        cwd: harness.ctx._session.workingDir,
      });

      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/park`,
      });

      expect(res.statusCode).toBe(200);
      expect(harness.ctx._session.setNativeResumeId).toHaveBeenCalledWith(null);
      expect(harness.ctx._session.nativeResumeId).toBeNull();
    }
  );

  it('a capture failure (setNativeResumeId throws) does not block parking', async () => {
    harness.ctx._session.mode = 'codex';
    // No fixture needed — capture will resolve to null; what matters is that
    // applying it (setNativeResumeId) throws, exercising the isolated
    // try/catch the route wraps around the whole capture-and-apply step so a
    // failure there never blocks session.park() from running.
    harness.ctx._session.setNativeResumeId.mockImplementationOnce(() => {
      throw new Error('boom');
    });

    const res = await harness.app.inject({
      method: 'POST',
      url: `/api/sessions/${harness.ctx._sessionId}/park`,
    });

    expect(res.statusCode).toBe(200);
    expect(harness.ctx._session.park).toHaveBeenCalledTimes(1);
  });
});
