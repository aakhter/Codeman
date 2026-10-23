import { realpathSync } from 'node:fs';
import { open, opendir, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { LRUMap } from './utils/lru-map.js';

const UUID_AT_END = /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

export interface CodexConversationIdentityOptions {
  codexHome: string;
  sessionId: string;
  resumeSessionId?: string;
  nativeResumeId?: string;
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
const historyPinCache = new LRUMap<
  string,
  { submitAt: number; competingKey: string; id: string; historyMtimeMs: number; historySize: number }
>({ maxSize: 1024 });
const ROLLOUT_INVENTORY_TTL_MS = 10_000;
const rolloutInventoryCache = new Map<string, { expiresAt: number; files: CodexRolloutFile[] }>();
const missingHistoryRolloutCache = new LRUMap<string, number>({ maxSize: 1024 });
let rolloutTreeWalkCount = 0;
let authoritativeDirectoryScanCount = 0;

/** Stable filesystem identity for rollout ownership and cache boundaries. */
export function canonicalizeCodexHome(codexHome: string, workingDir = process.cwd()): string {
  const absolute = resolve(workingDir, codexHome);
  try {
    return realpathSync.native(absolute);
  } catch {
    // Custom homes may not exist until Codex first starts. Keep a stable,
    // absolute lexical identity without surfacing filesystem failures.
    return absolute;
  }
}

/** Match the interactive pane's CODEX_HOME selection and cwd interpretation. */
export function resolveEffectiveCodexHome(
  sessionCodexHome: string | undefined,
  workingDir: string,
  processEnvironment: Readonly<Record<string, string | undefined>> = process.env
): string {
  const configuredHome = sessionCodexHome || processEnvironment.CODEX_HOME;
  const selectedHome = configuredHome || join(processEnvironment.HOME || tmpdir(), '.codex');
  return canonicalizeCodexHome(selectedHome, workingDir);
}

/** Invalidate best-effort viewer inventory when history or authoritative proof changes. */
export function invalidateCodexConversationInventory(codexHome: string): void {
  rolloutInventoryCache.delete(codexHome);
}

/** Test-only observability for proving repeated polling does not rescan unchanged trees. */
export function resetCodexConversationIdentityDebugStats(): void {
  rolloutTreeWalkCount = 0;
  authoritativeDirectoryScanCount = 0;
  rolloutInventoryCache.clear();
  missingHistoryRolloutCache.clear();
}

export function getCodexConversationIdentityDebugStats(): {
  rolloutTreeWalkCount: number;
  authoritativeDirectoryScanCount: number;
} {
  return { rolloutTreeWalkCount, authoritativeDirectoryScanCount };
}

async function listRecentCodexRollouts(codexHome: string, now = new Date()): Promise<CodexRolloutFile[]> {
  authoritativeDirectoryScanCount += 1;
  const sessionsDir = join(codexHome, 'sessions');
  const directories = new Set<string>([sessionsDir]);
  for (let daysAgo = 0; daysAgo <= 1; daysAgo += 1) {
    const date = new Date(now.getTime() - daysAgo * 24 * 60 * 60 * 1000);
    directories.add(
      join(
        sessionsDir,
        String(date.getFullYear()),
        String(date.getMonth() + 1).padStart(2, '0'),
        String(date.getDate()).padStart(2, '0')
      )
    );
    directories.add(
      join(
        sessionsDir,
        String(date.getUTCFullYear()),
        String(date.getUTCMonth() + 1).padStart(2, '0'),
        String(date.getUTCDate()).padStart(2, '0')
      )
    );
  }
  const files: CodexRolloutFile[] = [];
  for (const dir of directories) {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const path = join(dir, entry.name);
      const info = await stat(path).catch(() => undefined);
      if (!info) continue;
      files.push({
        path,
        mtimeMs: info.mtimeMs,
        id: basename(path).match(UUID_AT_END)?.[1],
        ...(await readCodexRolloutMeta(path)),
      });
    }
  }
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

async function readCodexRolloutMeta(
  path: string,
  maxBytes?: number
): Promise<Pick<CodexRolloutFile, 'cwd' | 'originator'>> {
  const cached = maxBytes === undefined ? rolloutMetaCache.get(path) : undefined;
  if (cached) return cached;
  const metadata: Pick<CodexRolloutFile, 'cwd' | 'originator'> = {};
  const handle = await open(path, 'r').catch(() => undefined);
  if (!handle) return metadata;
  try {
    const buffer = Buffer.alloc(maxBytes ?? 131072);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const complete = buffer.subarray(0, bytesRead).toString('utf8').split('\n');
    complete.pop();
    for (const line of complete) {
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
  if (maxBytes === undefined && (metadata.cwd || metadata.originator)) rolloutMetaCache.set(path, metadata);
  return metadata;
}

async function listCodexRollouts(codexHome: string): Promise<CodexRolloutFile[]> {
  const cached = rolloutInventoryCache.get(codexHome);
  if (cached && cached.expiresAt > Date.now()) return cached.files;
  rolloutTreeWalkCount += 1;
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
  const sorted = files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  rolloutInventoryCache.set(codexHome, { expiresAt: Date.now() + ROLLOUT_INVENTORY_TTL_MS, files: sorted });
  return sorted;
}

async function resolveCodexThreadFromHistory(options: CodexConversationIdentityOptions): Promise<string | undefined> {
  if (!options.lastSubmitAt) return undefined;
  const cacheKey = `${options.codexHome}\0${options.sessionId}`;
  const historyPath = join(options.codexHome, 'history.jsonl');
  const info = await stat(historyPath).catch(() => undefined);
  if (!info?.size) return undefined;
  const cached = historyPinCache.get(cacheKey);
  const competingKey = [...(options.competingSubmitAts ?? [])].sort((a, b) => a - b).join(',');
  if (
    cached?.submitAt === options.lastSubmitAt &&
    cached.competingKey === competingKey &&
    cached.historyMtimeMs === info.mtimeMs &&
    cached.historySize === info.size
  ) {
    return cached.id;
  }
  if (cached && (cached.historyMtimeMs !== info.mtimeMs || cached.historySize !== info.size)) {
    invalidateCodexConversationInventory(options.codexHome);
  }
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
  let ambiguous = false;
  for (const line of history.split('\n')) {
    try {
      const row = JSON.parse(line) as { session_id?: string; ts?: number };
      if (!row.session_id || typeof row.ts !== 'number') continue;
      const timestamp = row.ts * 1000;
      const distance = Math.abs(timestamp - options.lastSubmitAt);
      if (distance > 15_000) continue;
      if ((options.competingSubmitAts ?? []).some((time) => Math.abs(timestamp - time) <= distance)) continue;
      if (!best || distance < best.distance) {
        best = { id: row.session_id, distance };
        ambiguous = false;
      } else if (distance === best.distance && row.session_id !== best.id) {
        ambiguous = true;
      }
    } catch {
      // The first tail row or final row may be incomplete.
    }
  }
  if (best && !ambiguous) {
    historyPinCache.set(cacheKey, {
      submitAt: options.lastSubmitAt,
      competingKey,
      id: best.id,
      historyMtimeMs: info.mtimeMs,
      historySize: info.size,
    });
  }
  return ambiguous ? undefined : best?.id;
}

async function resolveCodexConversation(
  options: CodexConversationIdentityOptions,
  allowLegacyCwd: boolean
): Promise<ActiveCodexConversation | undefined> {
  const historyId = await resolveCodexThreadFromHistory(options);
  let files = await listCodexRollouts(options.codexHome);
  let historyFile = historyId ? files.find((file) => file.id === historyId) : undefined;
  const missingHistoryKey = historyId ? `${options.codexHome}\0${historyId}` : undefined;
  const missingUntil = missingHistoryKey ? missingHistoryRolloutCache.get(missingHistoryKey) : undefined;
  if (historyId && !historyFile && (!missingUntil || missingUntil <= Date.now())) {
    invalidateCodexConversationInventory(options.codexHome);
    files = await listCodexRollouts(options.codexHome);
    historyFile = files.find((file) => file.id === historyId);
    if (!historyFile && missingHistoryKey) {
      missingHistoryRolloutCache.set(missingHistoryKey, Date.now() + ROLLOUT_INVENTORY_TTL_MS);
    }
  }
  if (historyFile && missingHistoryKey) missingHistoryRolloutCache.delete(missingHistoryKey);
  if (historyFile?.id) return { id: historyFile.id, path: historyFile.path };

  const originator = `codeman_${options.sessionId}`;
  const owned = files.find((file) => file.originator === originator);
  if (owned?.id) return { id: owned.id, path: owned.path };
  const resumed = options.resumeSessionId ? files.find((file) => file.id === options.resumeSessionId) : undefined;
  if (resumed?.id) return { id: resumed.id, path: resumed.path };
  const nativeResume = options.nativeResumeId ? files.find((file) => file.id === options.nativeResumeId) : undefined;
  if (nativeResume?.id) return { id: nativeResume.id, path: nativeResume.path };
  const legacy =
    allowLegacyCwd && options.workingDir
      ? files.find(
          (file) =>
            file.cwd?.toLowerCase() === options.workingDir!.toLowerCase() && !file.originator?.startsWith('codeman_')
        )
      : undefined;
  return legacy?.id ? { id: legacy.id, path: legacy.path } : undefined;
}

/** Complete active-rollout resolver shared by checkpoint and response viewer. */
export async function findActiveCodexConversation(
  options: CodexConversationIdentityOptions
): Promise<ActiveCodexConversation | undefined> {
  return resolveCodexConversation(options, true);
}

/**
 * Strict resolver for contexts that may reach another model. Unlike the
 * response viewer, it never treats a matching cwd as ownership proof.
 */
export async function findOwnedCodexConversation(
  options: CodexConversationIdentityOptions
): Promise<ActiveCodexConversation | undefined> {
  return resolveCodexConversation({ ...options, codexHome: canonicalizeCodexHome(options.codexHome) }, false);
}

/** Optional hard budget for an inspection caller: exhausting it proves nothing. */
export interface CodexAttributionBudget {
  maxEntries: number;
  maxBytes: number;
}
async function listBoundedCodexRollouts(
  codexHome: string,
  budget: CodexAttributionBudget,
  explicitIds: readonly (string | undefined)[],
  sessionId: string
): Promise<CodexRolloutFile[] | undefined> {
  const directories = [{ path: join(codexHome, 'sessions'), depth: 0 }];
  const files: CodexRolloutFile[] = [];
  let entries = 0;
  let scanned = 131072; // Reserve a final complete metadata verification.
  while (directories.length) {
    const directory = directories.pop()!;
    const handle = await opendir(directory.path).catch(() => undefined);
    if (!handle) return undefined;
    for await (const entry of handle) {
      if (++entries > budget.maxEntries) return undefined;
      const path = join(directory.path, entry.name);
      if (entry.isDirectory()) {
        if (directory.depth >= 8) return undefined;
        directories.push({ path, depth: directory.depth + 1 });
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        const id = basename(path).match(UUID_AT_END)?.[1];
        if (explicitIds.length && !explicitIds.includes(id)) continue;
        const info = await stat(path).catch(() => undefined);
        if (!info) return undefined;
        const size = Math.min(info.size, 4096);
        if (scanned + size > budget.maxBytes) return undefined;
        scanned += size;
        const header = await open(path, 'r').catch(() => undefined);
        if (!header) return undefined;
        let mayMatch = explicitIds.length > 0;
        try {
          const bytes = Buffer.alloc(size);
          const { bytesRead } = await header.read(bytes, 0, size, 0);
          // A bounded prefix is only a cheap negative filter, never proof. A
          // candidate still needs a complete parsed metadata row below and an
          // independent final verification before it may be attributed.
          mayMatch ||= bytes
            .subarray(0, bytesRead)
            .toString('utf8')
            .includes(JSON.stringify(`codeman_${sessionId}`));
        } finally {
          await header.close();
        }
        if (!mayMatch) continue;
        const metadataBytes = Math.min(info.size, 131072);
        if (scanned + metadataBytes > budget.maxBytes) return undefined;
        scanned += metadataBytes;
        files.push({ path, id, mtimeMs: info.mtimeMs, ...(await readCodexRolloutMeta(path, metadataBytes)) });
      }
    }
  }
  return files;
}

/** Assistant binding never uses prompt timestamps, newest-file, or cwd-only guesses. */
export async function findExactCodexConversation(
  options: CodexConversationIdentityOptions,
  budget?: CodexAttributionBudget
): Promise<ActiveCodexConversation | undefined> {
  const codexHome = canonicalizeCodexHome(options.codexHome);
  invalidateCodexConversationInventory(codexHome);
  const explicitIds = [...new Set([options.resumeSessionId, options.nativeResumeId].filter(Boolean))];
  if (explicitIds.length > 1) return undefined;
  const files = budget
    ? await listBoundedCodexRollouts(codexHome, budget, explicitIds, options.sessionId)
    : await listCodexRollouts(codexHome);
  if (!files) return undefined;
  const candidates = explicitIds.length
    ? files.filter((file) => file.id === explicitIds[0])
    : files.filter((file) => file.originator === `codeman_${options.sessionId}`);
  if (candidates.length !== 1 || !candidates[0].id || !candidates[0].cwd || !options.workingDir) return undefined;
  // Re-read immutable native session metadata instead of trusting a filename or cached cwd alone.
  const handle = await open(candidates[0].path, 'r').catch(() => undefined);
  if (!handle) return undefined;
  try {
    const buffer = Buffer.alloc(131072);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n');
    lines.pop(); // A partial last row cannot prove identity.
    const metadata = lines
      .map((line) => {
        try {
          return JSON.parse(line) as { type?: string; payload?: { id?: string; cwd?: string; originator?: string } };
        } catch {
          return undefined;
        }
      })
      .filter((row) => row?.type === 'session_meta');
    if (
      metadata.length !== 1 ||
      metadata[0]?.payload?.id !== candidates[0].id ||
      metadata[0]?.payload?.cwd !== candidates[0].cwd ||
      (!explicitIds.length && metadata[0]?.payload?.originator !== `codeman_${options.sessionId}`)
    )
      return undefined;
  } finally {
    await handle.close();
  }
  let candidateDir: string;
  let expectedDir: string;
  try {
    candidateDir = realpathSync.native(candidates[0].cwd);
    expectedDir = realpathSync.native(options.workingDir);
  } catch {
    return undefined;
  }
  if (candidateDir !== expectedDir) return undefined;
  return { id: candidates[0].id, path: candidates[0].path };
}

/**
 * Resolve fresh-thread checkpoint proof only from a new rollout carrying this
 * managed pane's originator marker. Viewer history, resume IDs and cwd matches
 * are intentionally excluded because they are not post-transition proof.
 */
export async function findAuthoritativeCodexConversation(
  options: CodexConversationIdentityOptions & { baselineId?: string; baselineIds?: string[] }
): Promise<ActiveCodexConversation | undefined> {
  if (!options.baselineId) return undefined;
  const files = await listRecentCodexRollouts(options.codexHome);
  const originator = `codeman_${options.sessionId}`;
  const baselineIds = new Set([options.baselineId, ...(options.baselineIds ?? [])]);
  // The pre-command owned-ID snapshot is stronger than timestamp ordering:
  // filesystems may assign equal mtimes to distinct rollout creations.
  const owned = files.find((file) => file.id && !baselineIds.has(file.id) && file.originator === originator);
  return owned?.id ? { id: owned.id, path: owned.path } : undefined;
}

/** Snapshot recent rollout IDs owned by this managed pane before a thread transition. */
export async function findRecentOwnedCodexConversationIds(
  options: Pick<CodexConversationIdentityOptions, 'codexHome' | 'sessionId'>
): Promise<string[]> {
  const originator = `codeman_${options.sessionId}`;
  return (await listRecentCodexRollouts(options.codexHome))
    .filter((file): file is CodexRolloutFile & { id: string } => Boolean(file.id) && file.originator === originator)
    .map((file) => file.id);
}

/**
 * Resolve only a rollout demonstrably owned by this managed Codeman pane.
 * There is deliberately no cwd/latest-file fallback: ambiguity must fail closed.
 */
export async function findCodexConversationFile(
  options: CodexConversationIdentityOptions
): Promise<string | undefined> {
  return (await findOwnedCodexConversation(options))?.path;
}

export async function findCodexConversationId(options: CodexConversationIdentityOptions): Promise<string | undefined> {
  const filePath = await findCodexConversationFile(options);
  return filePath ? basename(filePath).match(UUID_AT_END)?.[1] : undefined;
}
