/** Private, secret-free recovery provenance for a session's Codex provider. */
export interface CodexProviderIdentity {
  version: 1;
  /** Whether recovery can reuse ambient auth or intentionally lost a session-scoped key. */
  credentialSource: 'restorable' | 'session-key';
  codexHome?: string;
}

/** Read only a recognized closed record; legacy or malformed provenance is unsafe. */
export function parseCodexProviderIdentity(value: unknown): CodexProviderIdentity | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (raw.version !== 1 || (raw.credentialSource !== 'restorable' && raw.credentialSource !== 'session-key')) {
    return undefined;
  }
  if ('codexHome' in raw && (typeof raw.codexHome !== 'string' || !raw.codexHome)) return undefined;
  return {
    version: 1,
    credentialSource: raw.credentialSource,
    ...(typeof raw.codexHome === 'string' ? { codexHome: raw.codexHome } : {}),
  };
}
