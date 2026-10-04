/** @fileoverview Stable owner-private project identities and notebook associations, independent of session lifecycle. */
import { createHash, randomUUID } from 'node:crypto';
import { realpath, rename } from 'node:fs/promises';
import { basename, dirname, join, posix, resolve } from 'node:path';
import { dataPath } from './config/instance.js';
import { SessionNotesFilesystem, safeNotesId, isNotesMissing } from './session-notes-filesystem.js';
import { SessionNotesStore } from './session-notes-store.js';
import type { CaseInfo } from './types/api.js';
import type { SessionNote, SessionNoteEntry } from './types/session-notes.js';
import type { SessionState } from './types/session.js';

export class SessionNotesProjectRegistryError extends Error {
  constructor(
    message: string,
    public readonly raw: string
  ) {
    super(`Notes project registry requires repair: ${message}`);
  }
}

export interface SessionNotesProject {
  id: string;
  name: string;
  root: string;
  executionLocation: string;
  source: 'configured' | 'directory';
  historical: boolean;
  customName: boolean;
}
/** Supply only launch/recovery metadata established for this owner's session. Never pass the terminal's live cwd. */
export interface SessionNotesProjectSession {
  id: string;
  workingDir: string;
  remote?: Pick<NonNullable<SessionState['remote']>, 'hostId' | 'remotePath'>;
  docker?: Pick<NonNullable<SessionState['docker']>, 'hostId' | 'containerName' | 'containerWorkdir'>;
}
export interface SessionNotesProjectResolution {
  /** The configured case chosen at launch, when retained by the caller. */
  chosenCase?: CaseInfo;
  /** Main repository root only when an established worktree association provides it. */
  mainRepositoryRoot?: string;
}
export interface SessionNotesSessionIdentity {
  id: string;
  sessionAliases?: string[];
  claudeSessionId?: string | null;
  resumeId?: string | null;
  /** Accepted for integration convenience; titles never participate in identity. */
  sessionTitle?: string;
}
interface Registry {
  version: 1;
  ownerKey: string;
  projects: SessionNotesProject[];
}
interface Mapping {
  root: string;
  executionLocation: string;
}

/** Map a trusted authenticated username (or the single-user sentinel) to a filesystem-safe owner key. */
export function sessionNotesOwnerKey(username?: string): string {
  return username === undefined ? 'single-user' : `u-${createHash('sha256').update(username).digest('hex')}`;
}
function location(kind: 'ssh' | 'docker', ...identity: string[]): string {
  if (identity.some((value) => typeof value !== 'string' || !value)) throw new Error('Missing execution identity');
  return `${kind}:${JSON.stringify(identity)}`;
}
async function canonicalRoot(path: string, executionLocation: string): Promise<string> {
  if (typeof path !== 'string' || !path || path.includes('\0')) throw new Error('Invalid project root');
  if (executionLocation !== 'local') {
    if (!posix.isAbsolute(path)) throw new Error('Remote project root must be absolute');
    return posix.normalize(path).replace(/\/$/, '') || '/';
  }
  const suffix: string[] = [];
  let existing = resolve(path);
  for (;;) {
    try {
      return join(await realpath(existing), ...suffix);
    } catch (error) {
      if (!isNotesMissing(error)) throw error;
      suffix.unshift(basename(existing));
      existing = dirname(existing);
    }
  }
}
async function caseMapping(info: CaseInfo): Promise<Mapping> {
  if (info.location === 'docker') {
    if (!info.docker) throw new Error('Missing Docker case metadata');
    const executionLocation = location('docker', info.docker.hostId, info.docker.container);
    return {
      executionLocation,
      root: await canonicalRoot(info.docker.containerWorkdir ?? info.docker.path, executionLocation),
    };
  }
  if (info.location === 'remote') {
    if (!info.remote) throw new Error('Missing remote case metadata');
    const executionLocation = location('ssh', info.remote.hostId);
    return { executionLocation, root: await canonicalRoot(info.remote.path, executionLocation) };
  }
  return { executionLocation: 'local', root: await canonicalRoot(info.path, 'local') };
}
/** Stable execution identity and canonical launch root from the existing remote/docker session fields. */
export async function sessionNotesLaunchMapping(session: SessionNotesProjectSession): Promise<Mapping> {
  const executionLocation = session.docker
    ? location('docker', session.docker.hostId, session.docker.containerName)
    : session.remote
      ? location('ssh', session.remote.hostId)
      : 'local';
  const path = session.docker?.containerWorkdir ?? session.remote?.remotePath ?? session.workingDir;
  return { executionLocation, root: await canonicalRoot(path, executionLocation) };
}
function same(a: Mapping, b: Mapping): boolean {
  return a.executionLocation === b.executionLocation && a.root === b.root;
}
function contains(root: string, path: string): boolean {
  return root === path || path.startsWith(root === '/' ? root : `${root}/`);
}

export class SessionNotesProjects extends SessionNotesFilesystem {
  constructor(
    root = dataPath('notes'),
    private readonly options: { checkpoint?: () => void | Promise<void> } = {}
  ) {
    super(root);
  }
  async list(owner: string): Promise<SessionNotesProject[]> {
    return this.withOwnerLock(owner, () => this.readRegistry(owner).then((registry) => registry.projects));
  }

  async sync(owner: string, cases: CaseInfo[]): Promise<SessionNotesProject[]> {
    const configured = await Promise.all(
      cases.map(async (info) => ({ ...(await caseMapping(info)), name: info.name }))
    );
    return this.withOwnerLock(owner, async () => {
      const registry = await this.readRegistry(owner);
      this.applyConfigured(registry, configured);
      await this.writeRegistry(owner, registry);
      return registry.projects;
    });
  }

  async resolve(
    owner: string,
    session: SessionNotesProjectSession,
    cases: CaseInfo[],
    options: SessionNotesProjectResolution = {}
  ): Promise<SessionNotesProject> {
    const launch = await sessionNotesLaunchMapping(session);
    const configured = await Promise.all(
      cases.map(async (info) => ({ ...(await caseMapping(info)), name: info.name }))
    );
    const chosen = options.chosenCase ? await caseMapping(options.chosenCase) : undefined;
    const mainRoot = options.mainRepositoryRoot
      ? await canonicalRoot(options.mainRepositoryRoot, launch.executionLocation)
      : undefined;
    return this.withOwnerLock(owner, async () => {
      const registry = await this.readRegistry(owner);
      this.applyConfigured(registry, configured);
      const available = registry.projects.filter(
        (project) =>
          project.source === 'configured' &&
          !project.historical &&
          project.executionLocation === launch.executionLocation
      );
      const containing = (path: string): SessionNotesProject | undefined =>
        available.filter((project) => contains(project.root, path)).sort((a, b) => b.root.length - a.root.length)[0];
      let project: SessionNotesProject | undefined;
      if (chosen && chosen.executionLocation === launch.executionLocation) {
        project = registry.projects.find((candidate) => same(candidate, chosen));
        if (!project) {
          project = {
            ...chosen,
            id: randomUUID(),
            name: options.chosenCase!.name,
            source: 'configured',
            historical: true,
            customName: false,
          };
          registry.projects.push(project);
        }
      }
      project ??= containing(launch.root) ?? (mainRoot ? containing(mainRoot) : undefined);
      if (!project) {
        project = registry.projects.find((candidate) => same(candidate, launch));
        if (!project) {
          project = {
            ...launch,
            id: randomUUID(),
            name: posix.basename(launch.root) || launch.root,
            source: 'directory',
            historical: false,
            customName: false,
          };
          registry.projects.push(project);
        }
      }
      await this.writeRegistry(owner, registry);
      return project;
    });
  }

  async rename(owner: string, id: string, name: string): Promise<SessionNotesProject> {
    if (typeof name !== 'string' || !name.trim() || name.length > 256) throw new Error('Invalid project name');
    safeNotesId(id);
    return this.withOwnerLock(owner, async () => {
      const registry = await this.readRegistry(owner);
      const project = registry.projects.find((candidate) => candidate.id === id);
      if (!project) throw new Error('Notes project not found');
      project.name = name.trim();
      project.customName = true;
      await this.writeRegistry(owner, registry);
      return project;
    });
  }

  /** Recovery and opening an existing notebook always reuse its persisted assignment, including manual moves. */
  async findNotebook(
    owner: string,
    identity: SessionNotesSessionIdentity,
    store = new SessionNotesStore(this.root),
    entries?: SessionNoteEntry[]
  ): Promise<SessionNote | null> {
    const notes = (entries ?? (await store.list(owner))).flatMap((entry) => (entry.note ? [entry.note] : []));
    const exact = notes.filter((note) => note.metadata.sessionId === identity.id);
    if (exact.length > 1) throw new Error('Ambiguous session notebook association');
    if (exact.length === 1) return exact[0];
    const aliases = new Set(
      [identity.id, ...(identity.sessionAliases ?? []), identity.claudeSessionId, identity.resumeId].filter(
        (value): value is string => typeof value === 'string' && !!value
      )
    );
    const found = notes.filter((note) =>
      [note.metadata.sessionId, ...note.metadata.sessionAliases].some((alias) => aliases.has(alias))
    );
    if (found.length > 1) throw new Error('Ambiguous conversation notebook association');
    return found[0] ?? null;
  }

  async reassign(
    owner: string,
    note: SessionNote,
    projectId: string,
    store = new SessionNotesStore(this.root)
  ): Promise<SessionNote> {
    safeNotesId(projectId);
    if (!(await this.list(owner)).some((project) => project.id === projectId))
      throw new Error('Notes project not found');
    return store.reassign(owner, note, projectId);
  }

  private applyConfigured(registry: Registry, configured: (Mapping & { name: string })[]): void {
    for (const project of registry.projects) if (project.source === 'configured') project.historical = true;
    for (const mapping of configured) {
      const existing = registry.projects.find((project) => same(project, mapping));
      if (existing) {
        existing.source = 'configured';
        existing.historical = false;
        if (!existing.customName) existing.name = mapping.name;
      } else
        registry.projects.push({
          ...mapping,
          id: randomUUID(),
          source: 'configured',
          historical: false,
          customName: false,
        });
    }
  }

  private async readRegistry(owner: string): Promise<Registry> {
    let raw: Buffer;
    try {
      raw = await this.bytes(join(this.ownerPath(owner), 'projects.json'));
    } catch (error) {
      if (isNotesMissing(error)) return { version: 1, ownerKey: owner, projects: [] };
      throw error;
    }
    try {
      const value = JSON.parse(raw.toString('utf8')) as Registry;
      if (value.version !== 1 || value.ownerKey !== owner || !Array.isArray(value.projects))
        throw new Error('Invalid notes project registry');
      const ids = new Set<string>();
      const mappings = new Set<string>();
      for (const project of value.projects) {
        if (!project || typeof project.id !== 'string') throw new Error('Invalid notes project');
        safeNotesId(project.id);
        const mapping = JSON.stringify([project.executionLocation, project.root]);
        if (
          ids.has(project.id) ||
          mappings.has(mapping) ||
          typeof project.name !== 'string' ||
          !project.name.trim() ||
          typeof project.root !== 'string' ||
          !posix.isAbsolute(project.root) ||
          typeof project.executionLocation !== 'string' ||
          !project.executionLocation ||
          !['directory', 'configured'].includes(project.source) ||
          typeof project.historical !== 'boolean' ||
          typeof project.customName !== 'boolean'
        )
          throw new Error('Invalid notes project registry');
        ids.add(project.id);
        mappings.add(mapping);
      }
      return value;
    } catch (error) {
      throw new SessionNotesProjectRegistryError((error as Error).message, raw.toString('utf8'));
    }
  }

  /** Keep the previous registry and complete staged versions in backup history; atomic rename publishes new bytes. */
  private async writeRegistry(owner: string, registry: Registry): Promise<void> {
    const directory = this.ownerPath(owner);
    const target = join(directory, 'projects.json');
    const bytes = Buffer.from(JSON.stringify(registry, null, 2) + '\n');
    let previous: Buffer | undefined;
    try {
      previous = await this.bytes(target);
    } catch (error) {
      if (!isNotesMissing(error)) throw error;
    }
    if (previous?.equals(bytes)) return;
    const history = join(directory, '.project-history');
    await this.directory(history);
    const temporary = join(history, `${randomUUID()}.staged`);
    await this.writePrivate(temporary, bytes);
    await this.syncDirectory(history);
    if (previous) await this.writePrivate(join(history, `${randomUUID()}.json`), previous);
    await this.syncDirectory(history);
    await this.options.checkpoint?.();
    await this.guard(target, true);
    await rename(temporary, target);
    await this.syncDirectory(directory);
  }
}
