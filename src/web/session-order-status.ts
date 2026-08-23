import type { AuthUser } from '../types/user.js';

interface OwnedSession {
  owner?: string;
}

/** Select the legacy order visible in an HTTP status response. */
export function sessionOrderForStatus(
  globalOrder: readonly string[],
  persistedSessions: Readonly<Record<string, OwnedSession>>,
  liveSessions: ReadonlyMap<string, OwnedSession>,
  identity: AuthUser | undefined,
  multiUser: boolean
): string[] {
  if (!multiUser || !identity || identity.role === 'admin') return [...globalOrder];

  const owners = new Map<string, string | undefined>();
  for (const [id, session] of Object.entries(persistedSessions)) owners.set(id, session.owner);
  for (const [id, session] of liveSessions) owners.set(id, session.owner);
  return globalOrder.filter((id) => owners.get(id) === identity.username);
}
