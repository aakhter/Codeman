import type { CodexCommandProfile, RemoteCase } from './types.js';

export type CodexCommandSelection = { ok: true; command: string | undefined } | { ok: false; error: string };

export function deriveCodexProfileName(command: string, existingNames: readonly string[]): string {
  const strippedCommand = command.trim().replace(/^exec\s+/i, '');
  const nameToken = strippedCommand
    .split(/\s+/)
    .reverse()
    .find((token) => !token.startsWith('-') && /[\p{L}\p{N}]/u.test(token));
  const baseName = nameToken ? toTitleCase(nameToken) : undefined;
  const existing = new Set(existingNames.map((name) => name.toLocaleLowerCase()));

  if (!baseName) {
    let importedNumber = 1;
    while (existing.has(`imported ${importedNumber}`)) importedNumber++;
    return `Imported ${importedNumber}`;
  }

  if (!existing.has(baseName.toLocaleLowerCase())) return baseName;

  let suffix = 2;
  while (existing.has(`${baseName} ${suffix}`.toLocaleLowerCase())) suffix++;
  return `${baseName} ${suffix}`;
}

export function findMatchingCodexProfile(
  command: string,
  profiles: readonly CodexCommandProfile[]
): CodexCommandProfile | undefined {
  const trimmedCommand = command.trim();
  return profiles.find((profile) => profile.command.trim() === trimmedCommand);
}

export function getCodexProfileUsage(cases: readonly RemoteCase[], profileId: string): string[] {
  return cases
    .filter((remoteCase) => remoteCase.codexCommandProfileId === profileId)
    .map((remoteCase) => remoteCase.name)
    .sort((left, right) => left.localeCompare(right));
}

export function resolveCodexCommandSelection(
  remoteCase: Pick<RemoteCase, 'codexCommandProfileId' | 'commands'>,
  profiles: readonly CodexCommandProfile[],
  hostCommand: string | undefined
): CodexCommandSelection {
  if (remoteCase.codexCommandProfileId !== undefined) {
    const profile = profiles.find((candidate) => candidate.id === remoteCase.codexCommandProfileId);
    if (!profile) return { ok: false, error: 'Saved Codex command profile is unavailable' };
    return { ok: true, command: profile.command };
  }

  if (remoteCase.commands?.codex !== undefined) return { ok: true, command: remoteCase.commands.codex };
  return { ok: true, command: hostCommand };
}

function toTitleCase(value: string): string {
  return value.length === 0 ? value : value[0].toLocaleUpperCase() + value.slice(1).toLocaleLowerCase();
}
