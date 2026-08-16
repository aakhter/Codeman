/** Private, secret-free recovery provenance for a session's Codex provider. */
export interface CodexProviderIdentity {
  CODEX_HOME?: string;
  /** Session-scoped credentials existed but their values were intentionally not persisted. */
  credentialsLost?: true;
}

/** Read only the closed private record; ignore unknown keys and malformed rows. */
export function parseCodexProviderIdentity(value: unknown): CodexProviderIdentity | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const identity: CodexProviderIdentity = {};
  if (typeof raw.CODEX_HOME === 'string' && raw.CODEX_HOME) identity.CODEX_HOME = raw.CODEX_HOME;
  if (raw.credentialsLost === true) identity.credentialsLost = true;
  return Object.keys(identity).length > 0 ? identity : undefined;
}
