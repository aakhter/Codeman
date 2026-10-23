/** Provider-native identities and durable observation cursors. No latest-conversation fallback. */
import { open, readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  findExactCodexConversation,
  canonicalizeCodexHome,
  resolveEffectiveCodexHome,
} from './checkpoint-conversation-identity.js';
import type { AssistantSession } from './assistant-registry.js';
import type { AssistantBinding } from './types/assistant.js';
import {
  claudeAssistantReady,
  openCodeAssistantReady,
  observeOpenCodeAssistantTurn,
} from './assistant-turn-observer.js';
import type { TurnObservation } from './assistant-turn-observer.js';
import { getCli } from './config/cli-registry/registry.js';

export const ASSISTANT_MODES = ['codex', 'claude', 'opencode'] as const;
export const assistantBindingMode = (binding: AssistantBinding) => binding.mode ?? 'codex';
export const nativeAssistantProfile = (mode: string) => getCli(mode)?.capabilities.nativeAssistantProfile;
export const openCodeAssistantHome = () =>
  canonicalizeCodexHome(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'));
export function assistantSessionHome(session: AssistantSession): string {
  const profile = nativeAssistantProfile(session.mode);
  if (profile === 'codex') return resolveEffectiveCodexHome(session.getCodexHomeOverride(), session.workingDir);
  if (profile === 'claude')
    return canonicalizeCodexHome(
      session.getClaudeConfigDirOverride?.() || process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'),
      session.workingDir
    );
  if (profile === 'opencode') return openCodeAssistantHome();
  throw new Error('Unsupported assistant provider');
}
export interface NativeConversation {
  id: string;
  path: string;
}
export interface NativeCursor {
  path: string;
  offset: number;
  inode: string;
  device: string;
  anchor?: string;
}
async function database<T>(path: string, read: (db: import('node:sqlite').DatabaseSync) => T): Promise<T> {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec('BEGIN');
    return read(db);
  } finally {
    db.close();
  }
}
export async function findAssistantConversation(
  binding: AssistantBinding,
  live?: AssistantSession
): Promise<NativeConversation | undefined> {
  const mode = assistantBindingMode(binding);
  const profile = nativeAssistantProfile(mode);
  if (live && (live.mode !== mode || assistantSessionHome(live) !== binding.codexHome)) return undefined;
  if (profile === 'codex')
    return findExactCodexConversation({
      codexHome: binding.codexHome,
      workingDir: binding.workingDir,
      sessionId: binding.sessionId,
      nativeResumeId: live?.nativeResumeId ?? binding.conversationId,
      resumeSessionId: live?.codexConfig?.resumeSessionId,
    });
  if (profile === 'claude') {
    const id = live?.claudeSessionId || live?.nativeResumeId || binding.conversationId || binding.sessionId;
    if (!/^[0-9a-f-]{36}$/i.test(id) || (binding.conversationId && id !== binding.conversationId)) return undefined;
    const projects = join(binding.codexHome, 'projects');
    const matches: string[] = [];
    for (const dir of await readdir(projects, { withFileTypes: true }).catch(() => [])) {
      if (!dir.isDirectory() && !dir.isSymbolicLink()) continue;
      const path = join(projects, dir.name, `${id}.jsonl`);
      try {
        const file = await open(path, 'r');
        let text: string;
        try {
          const buf = Buffer.alloc(128 * 1024);
          const r = await file.read(buf, 0, buf.length, 0);
          text = buf.subarray(0, r.bytesRead).toString('utf8');
        } finally {
          await file.close();
        }
        const rows = text.split('\n');
        rows.pop();
        let identity = false;
        for (const row of rows) {
          const j = JSON.parse(row) as { sessionId?: string; cwd?: string; isSidechain?: boolean; type?: string };
          if (
            !j.isSidechain &&
            ['user', 'assistant'].includes(j.type ?? '') &&
            j.sessionId === id &&
            j.cwd &&
            (await realpath(j.cwd)) === binding.workingDir
          )
            identity = true;
        }
        if (identity) matches.push(await realpath(path));
      } catch {
        /* Missing, partial, foreign or unreadable identities are never candidates. */
      }
    }
    return matches.length === 1 ? { id, path: matches[0] } : undefined;
  }
  const path = join(binding.codexHome, 'opencode', 'opencode.db');
  const id = live?.nativeResumeId || live?.openCodeConfig?.continueSession || binding.conversationId;
  if (id && !/^ses_[A-Za-z0-9_-]{1,120}$/.test(id)) return undefined;
  if (live?.openCodeConfig?.continueSession && live.openCodeConfig.continueSession !== id) return undefined;
  const pinned = Boolean(live?.openCodeConfig?.continueSession || binding.conversationId);
  return database(path, (db) => {
    const rows = db
      .prepare(
        pinned && id
          ? 'SELECT id,directory FROM session WHERE id = ?'
          : 'SELECT id,directory FROM session WHERE directory = ? LIMIT 2'
      )
      .all(pinned && id ? id : binding.workingDir) as Array<{ id: string; directory: string }>;
    return rows.length === 1 &&
      rows[0].directory === binding.workingDir &&
      (!id || rows[0].id === id) &&
      (!binding.conversationId || rows[0].id === binding.conversationId)
      ? { id: rows[0].id, path }
      : undefined;
  }).catch(() => undefined);
}
export async function resolveSessionAssistantConversation(
  session: AssistantSession
): Promise<{ conversation: NativeConversation; home: string; workingDir: string }> {
  const workingDir = await realpath(session.workingDir),
    home = assistantSessionHome(session);
  const conversation = await findAssistantConversation(
    {
      sessionId: session.id,
      conversationId: '',
      codexHome: home,
      workingDir,
      generation: 1,
      ...(nativeAssistantProfile(session.mode) !== 'codex' ? { mode: session.mode as 'claude' | 'opencode' } : {}),
    },
    session
  );
  if (!conversation) throw new Error('Exact native conversation identity is unavailable or ambiguous');
  return { conversation, home, workingDir };
}
async function openCodeRows(binding: AssistantBinding, path: string, after: number): Promise<string> {
  return database(path, (db) => {
    const rows = db
      .prepare('SELECT rowid,id,data FROM message WHERE session_id = ? AND rowid > ? ORDER BY rowid LIMIT 1001')
      .all(binding.conversationId, after) as Array<{ rowid: number; id: string; data: string }>;
    if (rows.length > 1000) throw new Error('Native message observation capacity exceeded');
    const records =
      rows
        .map((row) => {
          const parts = db
            .prepare(
              'SELECT data FROM part WHERE session_id = ? AND message_id = ? ORDER BY time_created,id LIMIT 1001'
            )
            .all(binding.conversationId, row.id) as Array<{ data: string }>;
          if (parts.length > 1000) throw new Error('Native part capacity exceeded');
          return JSON.stringify({
            type: 'opencode_message',
            payload: {
              ...JSON.parse(row.data),
              id: row.id,
              sessionID: binding.conversationId,
              parts: parts.map((p) => JSON.parse(p.data)),
            },
          });
        })
        .join('\n') + '\n';
    if (Buffer.byteLength(records) > 16 * 1024 * 1024) throw new Error('Native message observation capacity exceeded');
    return records;
  });
}
export async function snapshotOpenCode(binding: AssistantBinding, path: string): Promise<NativeCursor> {
  const info = await stat(path);
  const last = await database(
    path,
    (db) =>
      db
        .prepare('SELECT rowid,id FROM message WHERE session_id = ? ORDER BY rowid DESC LIMIT 1')
        .get(binding.conversationId) as { rowid: number; id: string } | undefined
  );
  return { path, offset: last?.rowid ?? 0, anchor: last?.id, inode: String(info.ino), device: String(info.dev) };
}
export async function observeOpenCode(
  binding: AssistantBinding,
  cursor: NativeCursor,
  prompt: string
): Promise<TurnObservation> {
  const info = await stat(cursor.path);
  if (String(info.ino) !== cursor.inode || String(info.dev) !== cursor.device)
    throw new Error('Native database identity changed');
  if (cursor.anchor) {
    const anchor = await database(
      cursor.path,
      (db) =>
        db
          .prepare('SELECT id FROM message WHERE session_id = ? AND rowid = ?')
          .get(binding.conversationId, cursor.offset) as { id: string } | undefined
    );
    if (anchor?.id !== cursor.anchor) throw new Error('Native message history changed');
  }
  return observeOpenCodeAssistantTurn(
    await openCodeRows(binding, cursor.path, cursor.offset),
    binding.conversationId,
    prompt
  );
}
export async function otherNativeReady(binding: AssistantBinding, path: string): Promise<boolean> {
  if (assistantBindingMode(binding) === 'opencode') {
    const lastUser = await database(
      path,
      (db) =>
        db
          .prepare(
            "SELECT rowid FROM message WHERE session_id=? AND json_extract(data,'$.role')='user' ORDER BY rowid DESC LIMIT 1"
          )
          .get(binding.conversationId) as { rowid: number } | undefined
    );
    return openCodeAssistantReady(
      await openCodeRows(binding, path, lastUser ? lastUser.rowid - 1 : 0),
      binding.conversationId
    );
  }
  const file = await open(path, 'r');
  try {
    const info = await file.stat(),
      length = Math.min(info.size, 1024 * 1024);
    if (!length) return false;
    const bytes = Buffer.alloc(length);
    await file.read(bytes, 0, length, info.size - length);
    if (bytes[length - 1] !== 10) return false;
    const lines = bytes.toString('utf8').split('\n');
    lines.pop();
    if (info.size > length) lines.shift();
    return claudeAssistantReady(lines.join('\n') + '\n', binding.conversationId);
  } finally {
    await file.close();
  }
}
