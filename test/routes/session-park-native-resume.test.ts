/**
 * COD-124 unit 2, Gap B — native external-CLI session-id capture at park time.
 * Widened by COD-251 from codex-only to opencode/gemini/agy.
 *
 * At park time (never speculatively), Codeman looks up that CLI's own on-disk
 * session/conversation record and stores the discovered id on the session as
 * `nativeResumeId`, so a later /resume can thread it back into the relaunch:
 *  - codex: newest matching rollout file under $CODEX_HOME/sessions (reusing
 *    the same findActiveCodexFile() discovery logic that backs the
 *    codexLastResponse endpoint) → `codex resume <id>`.
 *  - opencode: newest session row for the workingDir in its sqlite db
 *    ($XDG_DATA_HOME/opencode/opencode.db) → `--session <id>`.
 *  - gemini: workingDir → project slug via $GEMINI_HOME/projects.json, then
 *    the newest chats/session-*.jsonl for that slug → `--resume <id>`.
 *  - agy: last matching-workspace entry in $GEMINI_HOME/antigravity-cli/history.jsonl
 *    → `--conversation <id>` (a literal 'latest' is never captured — that
 *    means `--continue` instead).
 *
 * claude/shell have no analogous on-disk "resume this exact conversation by
 * id" mechanism wired into their CLI builders, so capture must return null
 * for them rather than inventing a resume flag that doesn't exist.
 *
 * These tests exercise the REAL discovery functions against isolated temp
 * store roots (no fs mocking), injected via CODEX_HOME/XDG_DATA_HOME/GEMINI_HOME
 * env vars, so the on-disk contract for each CLI stays honest.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRouteTestHarness, type RouteTestHarness } from './_route-test-utils.js';
import { registerSessionRoutes } from '../../src/web/routes/session-routes.js';

/** Whether node:sqlite is importable in this runtime (Node 22 needs --experimental-sqlite; Node 24+ is unflagged). */
let nodeSqliteAvailable = false;
try {
  await import('node:sqlite');
  nodeSqliteAvailable = true;
} catch {
  nodeSqliteAvailable = false;
}

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

  it('preserves an explicit Codex resume id instead of replacing it through discovery', async () => {
    harness.ctx._session.mode = 'codex';
    harness.ctx._session.codexConfig = { resumeSessionId: 'explicit_rollout_id' };
    writeRolloutFixture('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', {
      originator: `codeman_${harness.ctx._sessionId}`,
      cwd: harness.ctx._session.workingDir,
    });

    const res = await harness.app.inject({
      method: 'POST',
      url: `/api/sessions/${harness.ctx._sessionId}/park`,
    });

    expect(res.statusCode).toBe(200);
    expect(harness.ctx._session.setNativeResumeId).toHaveBeenCalledWith('explicit_rollout_id');
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

// node:sqlite (DatabaseSync) needs --experimental-sqlite on Node 22 (what CI
// runs today) and is unflagged on Node 24+; findOpencodeSessionId() already
// degrades to null when the dynamic import fails, so these tests are skipped
// (not failed) when the runtime doesn't support it rather than asserting
// behavior the runtime can't exercise.
describe.skipIf(!nodeSqliteAvailable)(
  'POST /api/sessions/:id/park — opencode native resume id capture (COD-251)',
  () => {
    let harness: RouteTestHarness;
    let dataHome: string;
    let prevDataHome: string | undefined;

    beforeEach(async () => {
      harness = await createRouteTestHarness(registerSessionRoutes);
      harness.ctx._session.mode = 'opencode';
      prevDataHome = process.env.XDG_DATA_HOME;
      dataHome = mkdtempSync(join(tmpdir(), 'codeman-opencode-datahome-'));
      process.env.XDG_DATA_HOME = dataHome;
    });

    afterEach(() => {
      if (prevDataHome === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = prevDataHome;
      rmSync(dataHome, { recursive: true, force: true });
    });

    async function writeOpencodeDb(rows: Array<{ id: string; directory: string; timeUpdated: number }>): Promise<void> {
      const { DatabaseSync } = await import('node:sqlite');
      const dbDir = join(dataHome, 'opencode');
      mkdirSync(dbDir, { recursive: true });
      const db = new DatabaseSync(join(dbDir, 'opencode.db'));
      db.exec('CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, time_updated INTEGER)');
      const insert = db.prepare('INSERT INTO session (id, directory, time_updated) VALUES (?, ?, ?)');
      for (const row of rows) insert.run(row.id, row.directory, row.timeUpdated);
      db.close();
    }

    it('captures the sole matching session id for the workingDir', async () => {
      await writeOpencodeDb([
        { id: 'ses_other_dir', directory: '/some/other/dir', timeUpdated: 999 },
        { id: 'ses_only', directory: harness.ctx._session.workingDir, timeUpdated: 100 },
      ]);

      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/park`,
      });

      expect(res.statusCode).toBe(200);
      expect(harness.ctx._session.setNativeResumeId).toHaveBeenCalledWith('ses_only');
    });

    it('does not associate a shared working directory with the newest concurrent pane', async () => {
      await writeOpencodeDb([
        { id: 'ses_first_pane', directory: harness.ctx._session.workingDir, timeUpdated: 100 },
        { id: 'ses_second_pane', directory: harness.ctx._session.workingDir, timeUpdated: 200 },
      ]);

      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/park`,
      });

      expect(res.statusCode).toBe(200);
      expect(harness.ctx._session.setNativeResumeId).toHaveBeenCalledWith(null);
    });

    it('captures null when no session row matches the workingDir', async () => {
      await writeOpencodeDb([{ id: 'ses_unrelated', directory: '/not/a/match', timeUpdated: 1 }]);

      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/park`,
      });

      expect(res.statusCode).toBe(200);
      expect(harness.ctx._session.setNativeResumeId).toHaveBeenCalledWith(null);
    });

    it('captures null (and does not throw) when the opencode db does not exist', async () => {
      // No db written — $XDG_DATA_HOME/opencode/opencode.db is absent.
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/park`,
      });

      expect(res.statusCode).toBe(200);
      expect(harness.ctx._session.setNativeResumeId).toHaveBeenCalledWith(null);
    });
  }
);

describe('POST /api/sessions/:id/park — gemini native resume id capture (COD-251)', () => {
  let harness: RouteTestHarness;
  let geminiHomeDir: string;
  let prevGeminiHome: string | undefined;

  beforeEach(async () => {
    harness = await createRouteTestHarness(registerSessionRoutes);
    harness.ctx._session.mode = 'gemini';
    prevGeminiHome = process.env.GEMINI_HOME;
    geminiHomeDir = mkdtempSync(join(tmpdir(), 'codeman-gemini-home-'));
    process.env.GEMINI_HOME = geminiHomeDir;
  });

  afterEach(() => {
    if (prevGeminiHome === undefined) delete process.env.GEMINI_HOME;
    else process.env.GEMINI_HOME = prevGeminiHome;
    rmSync(geminiHomeDir, { recursive: true, force: true });
  });

  function writeProjectsJson(mapping: Record<string, string>): void {
    writeFileSync(join(geminiHomeDir, 'projects.json'), JSON.stringify({ projects: mapping }));
  }

  function writeChatFixture(slug: string, filename: string, sessionId: string): void {
    const chatsDir = join(geminiHomeDir, 'tmp', slug, 'chats');
    mkdirSync(chatsDir, { recursive: true });
    writeFileSync(join(chatsDir, filename), `${JSON.stringify({ sessionId })}\n`);
  }

  it('captures the newest chat transcript session id for the mapped project slug', async () => {
    const workingDir = harness.ctx._session.workingDir;
    writeProjectsJson({ [workingDir]: 'my-slug' });
    writeChatFixture('my-slug', 'session-older.jsonl', 'gemini-old-id');
    // Force a distinct, newer mtime on the second fixture.
    await new Promise((r) => setTimeout(r, 10));
    writeChatFixture('my-slug', 'session-newer.jsonl', 'gemini-new-id');

    const res = await harness.app.inject({
      method: 'POST',
      url: `/api/sessions/${harness.ctx._sessionId}/park`,
    });

    expect(res.statusCode).toBe(200);
    expect(harness.ctx._session.setNativeResumeId).toHaveBeenCalledWith('gemini-new-id');
  });

  it('captures null when workingDir has no entry in projects.json', async () => {
    writeProjectsJson({ '/some/unrelated/dir': 'other-slug' });

    const res = await harness.app.inject({
      method: 'POST',
      url: `/api/sessions/${harness.ctx._sessionId}/park`,
    });

    expect(res.statusCode).toBe(200);
    expect(harness.ctx._session.setNativeResumeId).toHaveBeenCalledWith(null);
  });

  it('captures null (and does not throw) when projects.json is missing', async () => {
    // No projects.json written at all.
    const res = await harness.app.inject({
      method: 'POST',
      url: `/api/sessions/${harness.ctx._sessionId}/park`,
    });

    expect(res.statusCode).toBe(200);
    expect(harness.ctx._session.setNativeResumeId).toHaveBeenCalledWith(null);
  });

  it('captures null (and does not throw) when projects.json is malformed JSON', async () => {
    writeFileSync(join(geminiHomeDir, 'projects.json'), '{not valid json');

    const res = await harness.app.inject({
      method: 'POST',
      url: `/api/sessions/${harness.ctx._sessionId}/park`,
    });

    expect(res.statusCode).toBe(200);
    expect(harness.ctx._session.setNativeResumeId).toHaveBeenCalledWith(null);
  });
});

describe('POST /api/sessions/:id/park — antigravity native resume id capture (COD-251)', () => {
  let harness: RouteTestHarness;
  let geminiHomeDir: string;
  let prevGeminiHome: string | undefined;

  beforeEach(async () => {
    harness = await createRouteTestHarness(registerSessionRoutes);
    harness.ctx._session.mode = 'antigravity';
    prevGeminiHome = process.env.GEMINI_HOME;
    geminiHomeDir = mkdtempSync(join(tmpdir(), 'codeman-agy-home-'));
    process.env.GEMINI_HOME = geminiHomeDir;
  });

  afterEach(() => {
    if (prevGeminiHome === undefined) delete process.env.GEMINI_HOME;
    else process.env.GEMINI_HOME = prevGeminiHome;
    rmSync(geminiHomeDir, { recursive: true, force: true });
  });

  function writeHistoryFixture(lines: unknown[]): void {
    const dir = join(geminiHomeDir, 'antigravity-cli');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'history.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  }

  it('captures the last matching-workspace conversation id', async () => {
    const workspace = harness.ctx._session.workingDir;
    writeHistoryFixture([
      { workspace, conversationId: 'conv-first' },
      { workspace: '/other/workspace', conversationId: 'conv-unrelated' },
      { workspace, conversationId: 'conv-last' },
    ]);

    const res = await harness.app.inject({
      method: 'POST',
      url: `/api/sessions/${harness.ctx._sessionId}/park`,
    });

    expect(res.statusCode).toBe(200);
    expect(harness.ctx._session.setNativeResumeId).toHaveBeenCalledWith('conv-last');
  });

  it('captures null when no history entry matches the workingDir', async () => {
    writeHistoryFixture([{ workspace: '/unrelated', conversationId: 'conv-x' }]);

    const res = await harness.app.inject({
      method: 'POST',
      url: `/api/sessions/${harness.ctx._sessionId}/park`,
    });

    expect(res.statusCode).toBe(200);
    expect(harness.ctx._session.setNativeResumeId).toHaveBeenCalledWith(null);
  });

  it('captures null (and does not throw) when history.jsonl is missing', async () => {
    // No history.jsonl written at all.
    const res = await harness.app.inject({
      method: 'POST',
      url: `/api/sessions/${harness.ctx._sessionId}/park`,
    });

    expect(res.statusCode).toBe(200);
    expect(harness.ctx._session.setNativeResumeId).toHaveBeenCalledWith(null);
  });

  it('skips malformed lines and never captures the literal "latest" sentinel', async () => {
    const workspace = harness.ctx._session.workingDir;
    writeHistoryFixture([{ workspace, conversationId: 'conv-real' }]);
    // Append a malformed line and a trailing 'latest' entry by hand.
    const historyPath = join(geminiHomeDir, 'antigravity-cli', 'history.jsonl');
    const existing = readFileSync(historyPath, 'utf8');
    writeFileSync(
      historyPath,
      existing + 'not valid json\n' + JSON.stringify({ workspace, conversationId: 'latest' }) + '\n'
    );

    const res = await harness.app.inject({
      method: 'POST',
      url: `/api/sessions/${harness.ctx._sessionId}/park`,
    });

    expect(res.statusCode).toBe(200);
    // 'latest' must never be captured as a literal id — findAgySessionId
    // treats it as "no id to restore" so buildAgyCommand() falls back to
    // --continue instead of --conversation latest.
    expect(harness.ctx._session.setNativeResumeId).toHaveBeenCalledWith(null);
  });
});
