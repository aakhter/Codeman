/** Read-only display metadata for interrupted sessions; never changes resume eligibility. */
import { open, readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getDataDir } from './config/instance.js';
import { MAX_SESSION_NAME_LENGTH } from './config/terminal-limits.js';
import { codexThreadBySessionId, scanCodexSessionIdentities } from './codex-transcript.js';
import { claudeProjectsDir } from './utils/claude-transcript.js';
import type { SessionRecoveryRecord } from './types/session-recovery.js';

export type RecoveryDisplayRecord = SessionRecoveryRecord & { nameFromLifecycle?: boolean; conversationName?: string };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function displayName(value: unknown): string | undefined {
  return typeof value === 'string' ? value.trim().slice(0, MAX_SESSION_NAME_LENGTH) || undefined : undefined;
}
async function metadataRows(path: string): Promise<Array<Record<string, unknown>>> {
  const raw = await readFile(path, 'utf8').catch(() => '');
  return raw.split('\n').flatMap((line) => {
    try {
      const row: unknown = JSON.parse(line);
      return row && typeof row === 'object' && !Array.isArray(row) ? [row as Record<string, unknown>] : [];
    } catch {
      return [];
    }
  });
}

/** Exact ID lookup, with bounded reads for the title; missing files remain unverified. */
export async function readClaudeRecoveryDetails(
  record: Pick<SessionRecoveryRecord, 'sourceSessionId' | 'claudeResumeId'>
): Promise<{ resumeId?: string; conversationName?: string }> {
  const id = record.claudeResumeId || record.sourceSessionId;
  if (!UUID.test(id)) return {};
  const root = claudeProjectsDir();
  const dirs = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    const path = join(root, dir.name, `${id}.jsonl`);
    const info = await stat(path).catch(() => null);
    if (!info?.isFile()) continue;
    const file = await open(path, 'r').catch(() => null);
    if (!file) continue;
    try {
      const window = 65536;
      const size = Math.min(window, info.size);
      const head = Buffer.alloc(size);
      const first = await file.read(head, 0, size, 0);
      let text = head.subarray(0, first.bytesRead).toString('utf8');
      if (info.size > window) {
        const tail = Buffer.alloc(size);
        const last = await file.read(tail, 0, size, info.size - size);
        const tailText = tail.subarray(0, last.bytesRead).toString('utf8');
        text += '\n' + tailText.slice(tailText.indexOf('\n') + 1);
      }
      let custom: string | undefined;
      let ai: string | undefined;
      for (const line of text.split('\n')) {
        try {
          const row = JSON.parse(line) as { type?: string; customTitle?: unknown; aiTitle?: unknown };
          if (row.type === 'custom-title') custom = displayName(row.customTitle);
          if (row.type === 'ai-title') ai = displayName(row.aiTitle);
        } catch {
          /* Partial window or malformed line. */
        }
      }
      return { resumeId: id, ...(custom || ai ? { conversationName: custom || ai } : {}) };
    } finally {
      await file.close();
    }
  }
  return {};
}

export async function enrichRecoveryNames(
  records: readonly SessionRecoveryRecord[],
  getSaved: (id: string) => { name?: string } | null | undefined = () => null,
  dataDir = getDataDir()
): Promise<RecoveryDisplayRecord[]> {
  const historicalNames = new Map<string, string>();
  for (const row of await metadataRows(join(dataDir, 'session-lifecycle.jsonl'))) {
    const name = displayName(row.name);
    if (typeof row.sessionId === 'string' && name && !name.startsWith('auto:'))
      historicalNames.set(row.sessionId, name);
  }
  const localCodex = records.some((record) => record.transport === 'local' && record.mode === 'codex');
  const titles = new Map<string, string>();
  let paneThreads = new Map<string, string>();
  let workspaces = new Map<string, string>();
  if (localCodex) {
    const home = process.env.CODEX_HOME || join(homedir(), '.codex');
    for (const row of await metadataRows(join(home, 'session_index.jsonl'))) {
      const title = displayName(row.thread_name);
      if (typeof row.id === 'string' && title) titles.set(row.id, title);
    }
    if (titles.size > 0) {
      const rows = await scanCodexSessionIdentities();
      paneThreads = codexThreadBySessionId(rows);
      workspaces = new Map(rows.map((row) => [row.sessionId, row.workingDir]));
    }
  }
  return Promise.all(
    records.map(async (record) => {
      const savedName = record.name || displayName(getSaved(record.sourceSessionId)?.name);
      const historicalName = savedName ? undefined : historicalNames.get(record.sourceSessionId);
      const view: RecoveryDisplayRecord = {
        ...record,
        ...(savedName || historicalName ? { name: savedName || historicalName } : {}),
        ...(historicalName ? { nameFromLifecycle: true } : {}),
      };
      if (record.transport !== 'local') return view;
      if (record.mode === 'codex') {
        const thread = record.nativeResumeId || paneThreads.get(record.sourceSessionId);
        if (thread && (record.nativeResumeId || workspaces.get(thread) === record.workingDir)) {
          const name = titles.get(thread);
          if (name) view.conversationName = name;
        }
      } else if (record.mode === 'claude') {
        const details = await readClaudeRecoveryDetails(record).catch(() => ({}) as { conversationName?: string });
        if (details.conversationName) view.conversationName = details.conversationName;
      }
      return view;
    })
  );
}
