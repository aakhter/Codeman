import { basename, join } from 'node:path';
import { open, readdir, stat } from 'node:fs/promises';
import { LRUMap } from './utils/lru-map.js';

const UUID_AT_END = /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

export interface CodexConversationIdentityOptions {
  codexHome: string;
  sessionId: string;
  resumeSessionId?: string;
  workingDir?: string;
  lastSubmitAt?: number;
  competingSubmitAts?: number[];
}

export interface ActiveCodexConversation {
  id: string;
  path: string;
}

interface CodexRolloutFile {
  path: string;
  mtimeMs: number;
  id?: string;
  cwd?: string;
  originator?: string;
}

const rolloutMetaCache = new LRUMap<string, Pick<CodexRolloutFile, 'cwd' | 'originator'>>({ maxSize: 4096 });
const historyPinCache = new LRUMap<string, { submitAt: number; id: string }>({ maxSize: 1024 });

async function readCodexRolloutMeta(path: string): Promise<Pick<CodexRolloutFile, 'cwd' | 'originator'>> {
  const cached = rolloutMetaCache.get(path);
  if (cached) return cached;
  const metadata: Pick<CodexRolloutFile, 'cwd' | 'originator'> = {};
  const handle = await open(path, 'r').catch(() => undefined);
  if (!handle) return metadata;
  try {
    const buffer = Buffer.alloc(131072);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    for (const line of buffer.subarray(0, bytesRead).toString('utf8').split('\n')) {
      try {
        const row = JSON.parse(line) as {
          type?: string;
          payload?: { cwd?: string; originator?: string };
        };
        if (row.type === 'session_meta') {
          metadata.cwd ??= row.payload?.cwd;
          metadata.originator ??= row.payload?.originator;
        } else if (row.type === 'turn_context') metadata.cwd ??= row.payload?.cwd;
      } catch {
        // Partially flushed rows are not identity evidence.
      }
    }
  } finally {
    await handle.close();
  }
  // A newly created rollout may not have flushed identity metadata yet.
  if (metadata.cwd || metadata.originator) rolloutMetaCache.set(path, metadata);
  return metadata;
}

async function listCodexRollouts(codexHome: string): Promise<CodexRolloutFile[]> {
  const files: CodexRolloutFile[] = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        const info = await stat(path).catch(() => undefined);
        if (!info) continue;
        const file: CodexRolloutFile = {
          path,
          mtimeMs: info.mtimeMs,
          id: basename(path).match(UUID_AT_END)?.[1],
          ...(await readCodexRolloutMeta(path)),
        };
        files.push(file);
      }
    }
  };
  await walk(join(codexHome, 'sessions'));
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

async function resolveCodexThreadFromHistory(options: CodexConversationIdentityOptions): Promise<string | undefined> {
  if (!options.lastSubmitAt) return undefined;
  const cacheKey = `${options.codexHome}\0${options.sessionId}`;
  const cached = historyPinCache.get(cacheKey);
  if (cached?.submitAt === options.lastSubmitAt) return cached.id;
  const historyPath = join(options.codexHome, 'history.jsonl');
  const info = await stat(historyPath).catch(() => undefined);
  if (!info?.size) return undefined;
  const handle = await open(historyPath, 'r').catch(() => undefined);
  if (!handle) return undefined;
  let history = '';
  try {
    const length = Math.min(info.size, 65536);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, info.size - length);
    history = buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }

  let best: { id: string; distance: number } | undefined;
  for (const line of history.split('\n')) {
    try {
      const row = JSON.parse(line) as { session_id?: string; ts?: number };
      if (!row.session_id || typeof row.ts !== 'number') continue;
      const timestamp = row.ts * 1000;
      const distance = Math.abs(timestamp - options.lastSubmitAt);
      if (distance > 15_000) continue;
      if ((options.competingSubmitAts ?? []).some((time) => Math.abs(timestamp - time) < distance)) continue;
      if (!best || distance < best.distance) best = { id: row.session_id, distance };
    } catch {
      // The first tail row or final row may be incomplete.
    }
  }
  if (best) historyPinCache.set(cacheKey, { submitAt: options.lastSubmitAt, id: best.id });
  return best?.id;
}

/** Complete active-rollout resolver shared by checkpoint and response viewer. */
export async function findActiveCodexConversation(
  options: CodexConversationIdentityOptions
): Promise<ActiveCodexConversation | undefined> {
  const files = await listCodexRollouts(options.codexHome);
  const historyId = await resolveCodexThreadFromHistory(options);
  const historyFile = historyId ? files.find((file) => file.id === historyId) : undefined;
  if (historyFile?.id) return { id: historyFile.id, path: historyFile.path };

  const originator = `codeman_${options.sessionId}`;
  const owned = files.find((file) => file.originator === originator);
  if (owned?.id) return { id: owned.id, path: owned.path };
  const resumed = options.resumeSessionId ? files.find((file) => file.id === options.resumeSessionId) : undefined;
  if (resumed?.id) return { id: resumed.id, path: resumed.path };
  const legacy = options.workingDir
    ? files.find(
        (file) =>
          file.cwd?.toLowerCase() === options.workingDir!.toLowerCase() && !file.originator?.startsWith('codeman_')
      )
    : undefined;
  return legacy?.id ? { id: legacy.id, path: legacy.path } : undefined;
}

/**
 * Resolve only a rollout demonstrably owned by this managed Codeman pane.
 * There is deliberately no cwd/latest-file fallback: ambiguity must fail closed.
 */
export async function findCodexConversationFile(
  options: CodexConversationIdentityOptions
): Promise<string | undefined> {
  return (await findActiveCodexConversation(options))?.path;
}

export async function findCodexConversationId(options: CodexConversationIdentityOptions): Promise<string | undefined> {
  const filePath = await findCodexConversationFile(options);
  return filePath ? basename(filePath).match(UUID_AT_END)?.[1] : undefined;
}
