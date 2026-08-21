import path from 'node:path';

export interface SubagentIdentity {
  projectHash: string;
  claudeSessionId: string;
  agentId: string;
}

const SUBAGENT_KEY_PREFIX = 'v1.';

/** Normalize Claude's launch path lexically without resolving filesystem links. */
export function normalizeClaudeProjectPath(projectPath: string): string {
  const normalized = path.posix.normalize(projectPath);
  return normalized === '/' ? normalized : normalized.replace(/\/+$/, '');
}

/** Convert a launch path to the directory spelling used under ~/.claude/projects. */
export function claudeProjectHash(projectPath: string): string {
  return normalizeClaudeProjectPath(projectPath).replace(/\//g, '-');
}

/** Serialize the complete semantic subagent identity as a collision-safe opaque key. */
export function serializeSubagentKey(projectHash: string, claudeSessionId: string, agentId: string): string {
  return `${SUBAGENT_KEY_PREFIX}${Buffer.from(JSON.stringify([projectHash, claudeSessionId, agentId])).toString(
    'base64url'
  )}`;
}

/** Parse an opaque subagent key, returning null for untrusted or unsupported input. */
export function parseSubagentKey(key: string): SubagentIdentity | null {
  if (!key.startsWith(SUBAGENT_KEY_PREFIX)) return null;

  try {
    const tuple: unknown = JSON.parse(Buffer.from(key.slice(SUBAGENT_KEY_PREFIX.length), 'base64url').toString('utf8'));
    if (!Array.isArray(tuple) || tuple.length !== 3 || !tuple.every((value) => typeof value === 'string')) {
      return null;
    }
    const [projectHash, claudeSessionId, agentId] = tuple;
    if (serializeSubagentKey(projectHash, claudeSessionId, agentId) !== key) return null;
    return { projectHash, claudeSessionId, agentId };
  } catch {
    return null;
  }
}
