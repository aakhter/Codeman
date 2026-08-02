import { basename, join } from 'node:path';
import { open, readdir, stat } from 'node:fs/promises';

const UUID_AT_END = /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

export interface CodexConversationIdentityOptions {
  codexHome: string;
  sessionId: string;
  resumeSessionId?: string;
}

export interface ClaudeConversationIdentityOptions {
  claudeHome: string;
  workingDir: string;
  baselineId: string;
  transitionAt: number;
  competingTransitionAts?: number[];
}

/** Find the transcript created nearest this pane's fresh-thread command. */
export async function findClaudeConversationId(
  options: ClaudeConversationIdentityOptions
): Promise<string | undefined> {
  const candidates: Array<{ id: string; distance: number }> = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const filePath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(filePath);
        continue;
      }
      const match = entry.isFile() ? entry.name.match(/^([a-f0-9-]{36})\.jsonl$/i) : null;
      if (!match || match[1] === options.baselineId) continue;
      const info = await stat(filePath).catch(() => undefined);
      if (!info) continue;
      const distance = Math.abs(info.mtimeMs - options.transitionAt);
      if (distance > 15_000) continue;
      if ((options.competingTransitionAts ?? []).some((time) => Math.abs(info.mtimeMs - time) < distance)) continue;

      const handle = await open(filePath, 'r').catch(() => undefined);
      if (!handle) continue;
      try {
        const buffer = Buffer.alloc(65536);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        const bound = buffer
          .subarray(0, bytesRead)
          .toString('utf8')
          .split('\n')
          .some((line) => {
            try {
              const row = JSON.parse(line) as { cwd?: string; payload?: { cwd?: string } };
              return row.cwd === options.workingDir || row.payload?.cwd === options.workingDir;
            } catch {
              return false;
            }
          });
        if (bound) candidates.push({ id: match[1], distance });
      } finally {
        await handle.close();
      }
    }
  };
  await walk(join(options.claudeHome, 'projects'));
  candidates.sort((a, b) => a.distance - b.distance);
  if (candidates.length > 1 && candidates[0].distance === candidates[1].distance) return undefined;
  return candidates[0]?.id;
}

/**
 * Resolve only a rollout demonstrably owned by this managed Codeman pane.
 * There is deliberately no cwd/latest-file fallback: ambiguity must fail closed.
 */
export async function findCodexConversationFile(
  options: CodexConversationIdentityOptions
): Promise<string | undefined> {
  const files: Array<{ path: string; mtimeMs: number }> = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        const info = await stat(path).catch(() => undefined);
        if (info) files.push({ path, mtimeMs: info.mtimeMs });
      }
    }
  };
  await walk(join(options.codexHome, 'sessions'));
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const originator = `codeman_${options.sessionId}`;
  for (const file of files) {
    const handle = await open(file.path, 'r').catch(() => undefined);
    if (!handle) continue;
    try {
      const buffer = Buffer.alloc(131072);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      for (const line of buffer.subarray(0, bytesRead).toString('utf8').split('\n')) {
        try {
          const entry = JSON.parse(line) as { type?: string; payload?: { originator?: string } };
          if (entry.type === 'session_meta' && entry.payload?.originator === originator) {
            return file.path;
          }
        } catch {
          // A partially flushed first line is not identity evidence.
        }
      }
    } finally {
      await handle.close();
    }
  }

  if (options.resumeSessionId) {
    const match = files.find((file) => basename(file.path).endsWith(`-${options.resumeSessionId}.jsonl`));
    if (match) return match.path;
  }
  return undefined;
}

export async function findCodexConversationId(options: CodexConversationIdentityOptions): Promise<string | undefined> {
  const filePath = await findCodexConversationFile(options);
  return filePath ? basename(filePath).match(UUID_AT_END)?.[1] : undefined;
}
