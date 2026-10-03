/** Exact, secret-free native conversation identity discovery for reboot recovery. */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { codexThreadBySessionId, scanCodexSessionIdentities } from './codex-transcript.js';
import type { SessionState } from './types/session.js';

const CODEX_SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPENCODE_SESSION_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;
const OPENCODE_CLOCK_SLOP_MS = 5 * 60 * 1000;

function opencodeDataHome(): string {
  return process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
}

async function findCodexSessionId(session: Pick<SessionState, 'id' | 'workingDir'>): Promise<string | null> {
  const rows = await scanCodexSessionIdentities();
  const id = codexThreadBySessionId(rows).get(session.id);
  if (!id || !CODEX_SESSION_ID_PATTERN.test(id)) return null;
  const row = rows.find((candidate) => candidate.sessionId === id);
  return row?.workingDir === session.workingDir ? id : null;
}

/**
 * OpenCode has no Codeman originator field. A root session is safe only when
 * exactly one candidate was created for this workspace after the pane itself.
 * Child explore/build sessions never represent the resumable TUI and are
 * excluded explicitly.
 */
async function findOpenCodeSessionId(session: Pick<SessionState, 'workingDir' | 'createdAt'>): Promise<string | null> {
  let sqliteModule: typeof import('node:sqlite');
  try {
    sqliteModule = await import('node:sqlite');
  } catch {
    return null;
  }
  const dbPath = join(opencodeDataHome(), 'opencode', 'opencode.db');
  if (!existsSync(dbPath)) return null;
  let db: InstanceType<typeof sqliteModule.DatabaseSync> | undefined;
  try {
    db = new sqliteModule.DatabaseSync(dbPath, { readOnly: true });
    const rows = db
      .prepare(
        'SELECT id FROM session WHERE directory = ? AND parent_id IS NULL AND time_created >= ? ORDER BY time_created ASC LIMIT 2;'
      )
      .all(session.workingDir, Math.max(0, session.createdAt - OPENCODE_CLOCK_SLOP_MS)) as Array<{ id?: unknown }>;
    if (rows.length !== 1) return null;
    const id = typeof rows[0]?.id === 'string' ? rows[0].id : null;
    return id && OPENCODE_SESSION_ID_PATTERN.test(id) ? id : null;
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      // Best-effort read-only cleanup.
    }
  }
}

/** Resolve only identities that can be attributed without cwd-only guessing. */
export async function resolveNativeResumeIdForRecovery(session: SessionState): Promise<string | null> {
  if (session.nativeResumeId) return session.nativeResumeId;
  if (session.mode === 'codex') {
    if (session.codexConfig?.resumeSessionId) return session.codexConfig.resumeSessionId;
    return findCodexSessionId(session);
  }
  if (session.mode === 'opencode') {
    if (session.openCodeConfig?.continueSession) return session.openCodeConfig.continueSession;
    return findOpenCodeSessionId(session);
  }
  return null;
}

/** Reuse one Codex scan across a boot batch instead of rescanning every rollout per dead pane. */
export function createNativeResumeIdResolver(): (session: SessionState) => Promise<string | null> {
  let codexRowsPromise: ReturnType<typeof scanCodexSessionIdentities> | undefined;
  return async (session) => {
    if (session.nativeResumeId) return session.nativeResumeId;
    if (session.mode !== 'codex') return resolveNativeResumeIdForRecovery(session);
    if (session.codexConfig?.resumeSessionId) return session.codexConfig.resumeSessionId;
    codexRowsPromise ??= scanCodexSessionIdentities();
    const rows = await codexRowsPromise;
    const id = codexThreadBySessionId(rows).get(session.id);
    if (!id || !CODEX_SESSION_ID_PATTERN.test(id)) return null;
    return rows.find((candidate) => candidate.sessionId === id)?.workingDir === session.workingDir ? id : null;
  };
}

/** Re-probe an exact persisted Codex identity, or discover one by exact pane originator. */
export async function probeCodexRecoveryIdentity(record: {
  sourceSessionId: string;
  workingDir: string;
  nativeResumeId?: string;
}): Promise<string | null> {
  const rows = await scanCodexSessionIdentities({ fresh: true });
  const id = record.nativeResumeId ?? codexThreadBySessionId(rows).get(record.sourceSessionId);
  if (!id || !CODEX_SESSION_ID_PATTERN.test(id)) return null;
  return rows.some((row) => row.sessionId === id && row.workingDir === record.workingDir) ? id : null;
}
