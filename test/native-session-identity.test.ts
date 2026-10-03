import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { __clearCodexIdentityCache } from '../src/codex-transcript.js';
import { probeCodexRecoveryIdentity, resolveNativeResumeIdForRecovery } from '../src/native-session-identity.js';
import type { SessionState } from '../src/types/session.js';

function session(overrides: Partial<SessionState>): SessionState {
  return {
    id: 'codeman-session',
    pid: null,
    status: 'running',
    workingDir: '/work/project',
    currentTaskId: null,
    createdAt: 1_790_000_000_000,
    mode: 'codex',
    ...overrides,
  };
}

describe('native reboot recovery identity', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'codeman-native-id-'));
    process.env.CODEX_HOME = join(root, 'codex');
    process.env.XDG_DATA_HOME = join(root, 'xdg');
    __clearCodexIdentityCache();
  });

  afterEach(() => {
    delete process.env.CODEX_HOME;
    delete process.env.XDG_DATA_HOME;
    __clearCodexIdentityCache();
    rmSync(root, { recursive: true, force: true });
  });

  it('rechecks a persisted Codex ID on disk, bypassing cached identity after corruption', async () => {
    const id = '01a0c810-a5c4-7b32-be0b-1599d9d5995d';
    const dir = join(process.env.CODEX_HOME!, 'sessions', '2026', '09', '22');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'rollout-recheck.jsonl');
    const record = { sourceSessionId: 'pane', nativeResumeId: id, workingDir: '/work/project' };
    // Resumed sessions can have a different originator: the saved native ID is authoritative.
    writeFileSync(
      path,
      JSON.stringify({ type: 'session_meta', payload: { id, cwd: '/work/project', source: 'cli' } }) + '\n'
    );
    await expect(probeCodexRecoveryIdentity(record)).resolves.toBe(id);
    writeFileSync(path, JSON.stringify({ type: 'session_meta', payload: { id, cwd: '/other', source: 'cli' } }) + '\n');
    await expect(probeCodexRecoveryIdentity(record)).resolves.toBeNull();
    writeFileSync(
      path,
      JSON.stringify({ type: 'session_meta', payload: { id, cwd: '/work/project', source: { subagent: {} } } }) + '\n'
    );
    await expect(probeCodexRecoveryIdentity(record)).resolves.toBeNull();
    writeFileSync(path, 'corrupt metadata');
    await expect(probeCodexRecoveryIdentity(record)).resolves.toBeNull();
  });

  it('attributes the newest Codex rollout by its exact Codeman originator', async () => {
    const id = '01a0c810-a5c4-7b32-be0b-1599d9d5995d';
    const dir = join(process.env.CODEX_HOME!, 'sessions', '2026', '09', '22');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `rollout-test-${id}.jsonl`),
      `${JSON.stringify({ type: 'session_meta', payload: { id, cwd: '/work/project', originator: 'codeman_codeman-session' } })}\n${JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'continue the recovery work with enough bytes for discovery' } })}\n`
    );

    await expect(resolveNativeResumeIdForRecovery(session({}))).resolves.toBe(id);
  });

  it('finds a Codex identity older than the 400-row history limit', async () => {
    const dir = join(process.env.CODEX_HOME!, 'sessions', '2026', '09', '22');
    mkdirSync(dir, { recursive: true });
    const id = '01a0c810-a5c4-7b32-be0b-1599d9d5995d';
    for (let i = 0; i <= 400; i++) {
      const path = join(dir, `rollout-${i}.jsonl`);
      writeFileSync(
        path,
        JSON.stringify({
          type: 'session_meta',
          payload: {
            id: i === 0 ? id : `other-${i}`,
            cwd: '/work/project',
            originator: i === 0 ? 'codeman_codeman-session' : `codeman_other-${i}`,
          },
        }) + '\n'
      );
      utimesSync(path, 1000 + i, 1000 + i);
    }
    await expect(resolveNativeResumeIdForRecovery(session({}))).resolves.toBe(id);
  });

  it('ignores a newer child rollout that inherited the pane originator', async () => {
    const dir = join(process.env.CODEX_HOME!, 'sessions', '2026', '09', '22');
    mkdirSync(dir, { recursive: true });
    const rootId = '01a0c810-a5c4-7b32-be0b-1599d9d5995d';
    for (const [id, source, stamp] of [
      [rootId, 'cli', 1000],
      ['01a0c810-a5c4-7b32-be0b-1599d9d5995e', { subagent: { other: 'guardian' } }, 2000],
    ] as const) {
      const path = join(dir, `rollout-${id}.jsonl`);
      writeFileSync(
        path,
        JSON.stringify({
          type: 'session_meta',
          payload: {
            id,
            cwd: '/work/project',
            originator: 'codeman_codeman-session',
            source,
          },
        }) + '\n'
      );
      utimesSync(path, stamp, stamp);
    }
    await expect(resolveNativeResumeIdForRecovery(session({}))).resolves.toBe(rootId);
  });

  it('selects one OpenCode root and ignores its child agents', async () => {
    const dbDir = join(process.env.XDG_DATA_HOME!, 'opencode');
    mkdirSync(dbDir, { recursive: true });
    const db = new DatabaseSync(join(dbDir, 'opencode.db'));
    db.exec(
      'CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT NOT NULL, parent_id TEXT, time_created INTEGER NOT NULL);'
    );
    db.prepare('INSERT INTO session VALUES (?, ?, ?, ?)').run('ses_root', '/work/project', null, 1_790_000_001_000);
    db.prepare('INSERT INTO session VALUES (?, ?, ?, ?)').run(
      'ses_child',
      '/work/project',
      'ses_root',
      1_790_000_002_000
    );
    db.close();

    await expect(resolveNativeResumeIdForRecovery(session({ mode: 'opencode' }))).resolves.toBe('ses_root');
  });

  it('fails closed when two OpenCode roots could belong to the pane', async () => {
    const dbDir = join(process.env.XDG_DATA_HOME!, 'opencode');
    mkdirSync(dbDir, { recursive: true });
    const db = new DatabaseSync(join(dbDir, 'opencode.db'));
    db.exec(
      'CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT NOT NULL, parent_id TEXT, time_created INTEGER NOT NULL);'
    );
    const insert = db.prepare('INSERT INTO session VALUES (?, ?, ?, ?)');
    insert.run('ses_one', '/work/project', null, 1_790_000_001_000);
    insert.run('ses_two', '/work/project', null, 1_790_000_002_000);
    db.close();

    await expect(resolveNativeResumeIdForRecovery(session({ mode: 'opencode' }))).resolves.toBeNull();
  });
});
