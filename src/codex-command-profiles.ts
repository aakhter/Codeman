import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import type { CodexCommandProfile, RemoteCase } from './types.js';
import type { StateStore } from './state-store.js';
import { readRemoteCases, writeRemoteCases } from './remote-hosts.js';

export type CodexCommandSelection =
  | { ok: true; command: string | undefined; resumeCommandTemplate?: string }
  | { ok: false; error: string };

export type CodexRecoveryStrategy =
  | { kind: 'built-in' }
  | { kind: 'template'; command: string }
  | { kind: 'manual_required' };

const SAFE_CODEX_RESUME_ID = /^[a-zA-Z0-9_-]+$/;

/** Runtime defense for templates loaded from legacy or manually edited state. */
export function isValidCodexResumeCommandTemplate(template: string): boolean {
  return (
    template.length > 0 &&
    template.length <= 300 &&
    (template.match(/\{\{resumeId\}\}/g) ?? []).length === 1 &&
    !template.replace(/\{\{resumeId\}\}/g, '').includes('{{')
  );
}

/** Chooses a recovery-safe command without ever modifying an opaque launcher. */
export function resolveCodexRecoveryStrategy(
  source: { command?: string; resumeCommandTemplate?: string },
  resumeId: string
): CodexRecoveryStrategy {
  if (!SAFE_CODEX_RESUME_ID.test(resumeId)) return { kind: 'manual_required' };
  if (source.command === undefined) return { kind: 'built-in' };
  if (!source.resumeCommandTemplate || !isValidCodexResumeCommandTemplate(source.resumeCommandTemplate)) {
    return { kind: 'manual_required' };
  }
  return { kind: 'template', command: source.resumeCommandTemplate.replace('{{resumeId}}', resumeId) };
}

type CodexCommandProfileStore = Pick<
  StateStore,
  'getCodexCommandProfiles' | 'setCodexCommandProfiles' | 'saveNowAsync' | 'getConfig'
>;

/** Serializes the shared remote-cases.json read-modify-write sequence across owners. */
let legacyMigrationChain: Promise<unknown> = Promise.resolve();

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
    return {
      ok: true,
      command: profile.command,
      ...(profile.resumeCommandTemplate ? { resumeCommandTemplate: profile.resumeCommandTemplate } : {}),
    };
  }

  if (remoteCase.commands?.codex !== undefined) return { ok: true, command: remoteCase.commands.codex };
  return { ok: true, command: hostCommand };
}

/**
 * Promotes legacy per-case Codex command overrides into an owner's reusable
 * profile library. The profile write deliberately precedes the case rewrite: a
 * crash may leave a duplicate-safe raw override, but never a dangling profile id.
 */
export async function migrateLegacyRemoteCaseCodexCommands(
  configDir: string,
  owner: string,
  store: CodexCommandProfileStore,
  options: { allowOwnerlessSingleUser: boolean }
): Promise<{ profiles: CodexCommandProfile[]; cases: RemoteCase[] }> {
  const next = legacyMigrationChain.then(() =>
    migrateLegacyRemoteCaseCodexCommandsOnce(configDir, owner, store, options)
  );
  // A failed migration must not prevent future owners from making progress.
  legacyMigrationChain = next.catch(() => undefined);
  return next;
}

async function migrateLegacyRemoteCaseCodexCommandsOnce(
  configDir: string,
  owner: string,
  store: CodexCommandProfileStore,
  options: { allowOwnerlessSingleUser: boolean }
): Promise<{ profiles: CodexCommandProfile[]; cases: RemoteCase[] }> {
  const cases = await readRemoteCases(configDir);
  const profiles = store.getCodexCommandProfiles(owner);
  let profilesChanged = false;
  let casesChanged = false;

  for (let index = 0; index < cases.length; index++) {
    const remoteCase = cases[index];
    const eligible = remoteCase.owner === owner || (options.allowOwnerlessSingleUser && remoteCase.owner === undefined);
    const rawCommand = remoteCase.commands?.codex?.trim();
    if (!eligible || !rawCommand || remoteCase.codexCommandProfileId !== undefined) continue;

    let profile = findMatchingCodexProfile(rawCommand, profiles);
    if (!profile) {
      profile = {
        id: randomUUID(),
        name: deriveCodexProfileName(
          rawCommand,
          profiles.map((candidate) => candidate.name)
        ),
        command: rawCommand,
      };
      profiles.push(profile);
      profilesChanged = true;
    }

    const { codex: _legacyCodex, ...otherCommands } = remoteCase.commands ?? {};
    cases[index] = {
      ...remoteCase,
      codexCommandProfileId: profile.id,
      ...(Object.keys(otherCommands).length > 0 ? { commands: otherCommands } : {}),
    };
    if (Object.keys(otherCommands).length === 0) delete cases[index].commands;
    casesChanged = true;
  }

  if (profilesChanged) store.setCodexCommandProfiles(owner, profiles);
  if (casesChanged) {
    await store.saveNowAsync();
    await assertProfilesPersisted(store, owner, profiles);
    await writeRemoteCases(configDir, cases);
  }
  return { profiles, cases };
}

async function assertProfilesPersisted(
  store: CodexCommandProfileStore,
  owner: string,
  profiles: readonly CodexCommandProfile[]
): Promise<void> {
  const raw = await fs.readFile(store.getConfig().stateFilePath, 'utf-8');
  const parsed = JSON.parse(raw) as { codexCommandProfiles?: Record<string, CodexCommandProfile[]> };
  const persisted = parsed.codexCommandProfiles?.[owner] ?? [];
  if (!profiles.every((profile) => persisted.some((candidate) => candidate.id === profile.id))) {
    throw new Error('Codex command profile library was not durably persisted');
  }
}

function toTitleCase(value: string): string {
  return value.length === 0 ? value : value[0].toLocaleUpperCase() + value.slice(1).toLocaleLowerCase();
}
