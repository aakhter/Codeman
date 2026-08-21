/**
 * @fileoverview Case management routes.
 * Handles CRUD for cases (directories under ~/codeman-cases and linked folders),
 * cloning a repository into a new case (`/api/cases/clone` + `/clone-preflight`,
 * issue #236 — the URL-safety rules live in `src/git-clone.ts`), fix-plan reading,
 * and ralph-wizard file serving.
 */

import { FastifyInstance } from 'fastify';
import { existsSync, lstatSync, mkdirSync, writeFileSync, readdirSync, readFileSync, createReadStream } from 'node:fs';
import { exec, execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { basename, dirname, join, posix as posixPath, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import type { ApiResponse, CaseInfo, DockerHost, RemoteSessionInfo, SessionDocker } from '../../types.js';
import { ApiErrorCode, createErrorResponse, getErrorMessage } from '../../types.js';
import {
  BrowseDirectoryQuerySchema,
  CreateCaseSchema,
  CloneCaseSchema,
  ClonePreflightSchema,
  LinkCaseSchema,
  CaseOrderSchema,
  RemoteCaseLinkSchema,
  RemoteHostSchema,
  UpdateCaseSchema,
  DockerCaseLinkSchema,
  DockerHostSchema,
  DockerExportSchema,
  DockerImportSchema,
  DockerQuickCreateSchema,
  CaseDefaultGroupSchema,
} from '../schemas.js';
import { exportDockerCase, importDockerBundle, listDockerExports, exportBundleName } from '../../docker-export.js';
import {
  cloneRepository,
  isGitAvailable,
  isSafeGitRef,
  parseGitRepositoryUrl,
  probeGitRemote,
} from '../../git-clone.js';
import type { GitRemoteProbe, GitUrlParse } from '../../git-clone.js';
import { generateClaudeMd } from '../../templates/claude-md.js';
import { settingsWriteBlocker, writeHooksConfig } from '../../hooks-config.js';
import {
  canAccessOwned,
  getAuthUser,
  isAdmin,
  isWorkingDirAllowed,
  ownerFor,
  resolveCasesDir,
  SETTINGS_PATH,
  validatePathWithinBase,
  parseBody,
  readJsonConfig,
} from '../route-helpers.js';
import { isSensitivePath } from '../sensitive-path.js';
import { isMultiUserMode } from '../../config/multiuser.js';
import type { AuthUser } from '../../types.js';
import { SseEvent } from '../sse-events.js';
import type { EventPort, ConfigPort, SessionPort, TabLayoutPort } from '../ports/index.js';
import type { FastifyRequest } from 'fastify';
import { ownerLayoutKey } from '../../tab-layout-persistence.js';
import { dataPath, getDataDir } from '../../config/instance.js';
import {
  checkDockerAvailable,
  checkDockerImagePresent,
  checkDockerTmuxAvailable,
  ensureAgentBaseImage,
  DEFAULT_AGENT_IMAGE,
  dockerContainerName,
  dockerDisplayPath,
  readDockerCases,
  readDockerHosts,
  removeDockerContainer,
  toSessionDocker,
  writeDockerCases,
  writeDockerHosts,
} from '../../docker-hosts.js';
import { buildDockerRemoveCommand } from '../../tmux-manager.js';
import {
  checkRemoteSshAccess,
  listRemoteCodemanSessions,
  listRemoteDirectories,
  readRemoteCases,
  readRemoteHosts,
  remoteDisplayPath,
  writeRemoteCases,
  writeRemoteHosts,
} from '../../remote-hosts.js';
import { promisify } from 'node:util';
import { readSources, buildCatalog, readUserManifest } from '../../skill-install-reader.js';
import { classifyScope, summarize, type InstallEntry } from '../../skill-install-classifier.js';
import { stringify as stringifyToml } from 'smol-toml';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
// Must start with alphanumeric or underscore — no leading dash (would be a CLI flag) or dot
const SAFE_SKILL_ID = /^[a-zA-Z0-9_][a-zA-Z0-9_./-]*$/;

interface SkillEntry {
  kind: string;
  name: string;
  source: string | null;
  pack: string | null;
  klass: string;
  mirrorInstalled: boolean | null; // true=present, false=missing, null=N/A (agents/commands)
  claudePath: string; // prettified path in ~/.claude/...
  target: string | null; // symlink target (prettified), null for real files
  mirrorPath: string | null; // prettified ~/.agents/skills/... path (skills only)
  description: string; // bundle description if in a pack, else source description
}

interface SkillDetailResult {
  hasManifest: boolean;
  projectEntries: SkillEntry[];
  userEntries: SkillEntry[];
}

interface SkillCatalogPack {
  source: string;
  name: string;
  description: string;
  totalCount: number;
  installedCount: number;
}

interface SkillCatalogIndividual {
  kind: string;
  name: string;
  source: string;
  klass: string;
}

interface SkillCatalogResult {
  hasManifest: boolean;
  packs: SkillCatalogPack[];
  individuals: SkillCatalogIndividual[];
}

interface UserSkillsResult {
  hasManifest: boolean;
  entries: SkillEntry[];
}

interface SkillStateResult {
  hasManifest: boolean;
  installed: number;
  missing: number;
  drifted: number;
  primaryPack: string | null;
}

const LINKED_CASES_FILE = dataPath('linked-cases.json');
const CODEMAN_CONFIG_DIR = getDataDir();
const SAFE_CASE_NAME = /^[a-zA-Z0-9_-]+$/;
const DOCKER_EXPORTS_DIR = dataPath('docker-exports');
/** Auto-created host profile for the one-click "Run in Docker" case flow. */
const DEFAULT_DOCKER_HOST_ID = 'default';
const SINGLE_USER_OWNER = '@single';

function codexProfileOwner(owner: string | undefined): string {
  return owner ?? SINGLE_USER_OWNER;
}

/** App version for export manifests (best-effort read of package.json). */
const APP_VERSION = (() => {
  try {
    const pkgPath = fileURLToPath(new URL('../../../package.json', import.meta.url));
    return (JSON.parse(readFileSync(pkgPath, 'utf-8')).version as string) || 'unknown';
  } catch {
    return 'unknown';
  }
})();

interface DirectoryBrowseEntry {
  name: string;
  path: string;
}

interface DirectoryBrowseResponse {
  path: string;
  parentPath: string | null;
  entries: DirectoryBrowseEntry[];
}

/**
 * Refusal text for a `local`-transport clone by a non-admin in multi-user mode.
 * Per-user case spaces live inside one $HOME, so cloning from an absolute path
 * would copy another user's workspace into the caller's own (the same escape
 * `/api/cases/link` is admin-only for).
 */
const LOCAL_CLONE_ADMIN_ONLY =
  'Cloning from a local path is admin-only in multi-user mode. Use a repository URL instead.';

/**
 * The one line of git's stderr worth appending to an error message.
 *
 * NOT the first line: `git clone` opens with "Cloning into '<dest>'…", so a naive
 * first-line pick reported the destination path as the reason a bad branch failed
 * (observed against a real remote). Prefer the LAST diagnostic line
 * (`fatal:`/`error:`/`remote:`), which is where git puts the actual cause.
 */
function gitDiagnosticLine(stderr: string): string {
  const lines = stderr
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const line = [...lines].reverse().find((l) => /^(fatal|error|remote|warning):/i.test(l)) ?? lines.at(-1) ?? '';
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

/**
 * Does the freshly cloned tree carry its own Claude settings? Those can contain
 * hooks, which run on the user's machine when a session starts in the case, so
 * the clone response says so out loud instead of silently merging into them.
 */
function repoShipsClaudeSettings(casePath: string): boolean {
  return ['settings.json', 'settings.local.json'].some((file) => existsSync(join(casePath, '.claude', file)));
}

/** Read and parse linked-cases.json, returning empty object on missing/invalid file. */
async function readLinkedCases(): Promise<Record<string, string>> {
  return readJsonConfig<Record<string, string>>(LINKED_CASES_FILE, 'linked cases', {});
}

/**
 * Resolve a case name to its directory path, checking linked cases first, then the
 * user's case space (per-user in multi-user mode, the shared CASES_DIR otherwise).
 */
async function resolveCasePath(name: string, user?: AuthUser): Promise<string> {
  const linkedCases = await readLinkedCases();
  // Linked cases carry no owner (legacy/admin-only registry): a non-admin must not
  // resolve arbitrary linked paths by name in multi-user mode (path-escape guard).
  if (linkedCases[name] && (!isMultiUserMode() || user?.role === 'admin')) return linkedCases[name];
  return join(resolveCasesDir(user), name);
}

function expandLocalBrowsePath(path?: string): string {
  if (!path || path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return path;
}

function localParentPath(path: string): string | null {
  const parent = dirname(path);
  return parent === path ? null : parent;
}

function remoteParentPath(path: string): string | null {
  const normalized = posixPath.normalize(path);
  const parent = posixPath.dirname(normalized);
  return parent === normalized ? null : parent;
}

function toSkillEntry(e: InstallEntry, sources: import('../../skill-install-reader.js').SkillSource[]): SkillEntry {
  const mirrorInstalled = e.mirrorPath ? existsSync(e.mirrorPath) : null;
  const home = homedir();
  const prettify = (p: string | null) => (p ? p.replace(home, '~') : null);
  let description = '';
  if (e.source) {
    const src = sources.find((s) => s.name === e.source);
    if (e.pack && src) description = src.bundles?.[e.pack]?.description ?? '';
    if (!description && src) description = src.description;
  }
  return {
    kind: e.kind,
    name: e.name,
    source: e.source,
    pack: e.pack,
    klass: e.klass,
    mirrorInstalled,
    claudePath: prettify(e.claudePath) ?? e.claudePath,
    target: prettify(e.target),
    mirrorPath: prettify(e.mirrorPath),
    description,
  };
}

async function getSkillDetail(casePath: string): Promise<SkillDetailResult> {
  const sources = await readSources();
  if (!sources.length) return { hasManifest: false, projectEntries: [], userEntries: [] };
  const catalog = await buildCatalog(sources);
  const [projectRaw, userRaw] = await Promise.all([
    classifyScope(sources, catalog, casePath),
    classifyScope(sources, catalog, homedir()),
  ]);
  return {
    hasManifest: true,
    projectEntries: projectRaw.map((e) => toSkillEntry(e, sources)),
    userEntries: userRaw
      .filter((e) => e.klass === 'linked-managed' || e.klass === 'real')
      .map((e) => toSkillEntry(e, sources)),
  };
}

/**
 * Gate a docker case on its base image, AUTO-BUILDING the default image on first
 * use so a missing image is never a blocker (the user's ask: "create it when it's
 * used for the first time"). Present image → verify tmux (hard prerequisite).
 * Default image missing → kick off a BACKGROUND build with SSE progress and return
 * `imageBuilding: true` (the case is created regardless; first launch awaits the
 * same dedup'd build). Custom image missing → a real error (we can't build a
 * foreign ref, and `--pull=never` forbids pulling).
 */
async function ensureCaseImage(
  broadcast: EventPort['broadcast'],
  sessionDocker: SessionDocker,
  name: string
): Promise<{ ok: true; imageBuilding: boolean } | { ok: false; error: string }> {
  if (await checkDockerImagePresent(sessionDocker, sessionDocker.image)) {
    const tmuxCheck = await checkDockerTmuxAvailable(sessionDocker);
    if (!tmuxCheck.ok) return { ok: false, error: tmuxCheck.error || 'base image is missing tmux' };
    return { ok: true, imageBuilding: false };
  }
  if (sessionDocker.image !== DEFAULT_AGENT_IMAGE) {
    return {
      ok: false,
      error: `base image ${sessionDocker.image} not present; only ${DEFAULT_AGENT_IMAGE} is auto-built. Build or pull it first.`,
    };
  }
  broadcast(SseEvent.DockerImageBuildStarted, { name, image: sessionDocker.image });
  void ensureAgentBaseImage(sessionDocker, sessionDocker.image, {
    onProgress: (line) => broadcast(SseEvent.DockerImageBuildProgress, { name, line }),
  })
    .then((r) =>
      broadcast(r.ok ? SseEvent.DockerImageBuildComplete : SseEvent.DockerImageBuildFailed, {
        name,
        image: sessionDocker.image,
        error: r.error,
      })
    )
    .catch((err) =>
      broadcast(SseEvent.DockerImageBuildFailed, { name, image: sessionDocker.image, error: getErrorMessage(err) })
    );
  return { ok: true, imageBuilding: true };
}

export function registerCaseRoutes(
  app: FastifyInstance,
  ctx: EventPort & ConfigPort & SessionPort & TabLayoutPort
): void {
  const selectionMetadata = (
    remoteCase: { codexCommandProfileId?: string; commands?: Record<string, string> },
    owner: string | undefined,
    viewer: string | undefined
  ) => {
    if (remoteCase.codexCommandProfileId !== undefined) {
      if (owner !== viewer) return { kind: 'profile' as const, profileId: remoteCase.codexCommandProfileId };
      const profile = ctx.store
        .getCodexCommandProfiles(codexProfileOwner(viewer))
        .find((candidate) => candidate.id === remoteCase.codexCommandProfileId);
      return profile
        ? {
            kind: 'profile' as const,
            profileId: profile.id,
            name: profile.name,
            commandPreview: profile.command.slice(0, 120),
          }
        : { kind: 'profile' as const, profileId: remoteCase.codexCommandProfileId };
    }
    if (remoteCase.commands?.codex !== undefined) {
      return { kind: 'custom' as const, commandPreview: remoteCase.commands.codex.slice(0, 120) };
    }
    return { kind: 'default' as const };
  };

  const applyCodexSelection = (
    remoteCase: { codexCommandProfileId?: string; commands?: Record<string, string> },
    selection:
      | { kind: 'default' }
      | { kind: 'profile'; profileId: string }
      | { kind: 'custom'; command: string }
      | undefined,
    owner: string | undefined
  ):
    | { ok: true; value: { codexCommandProfileId?: string; commands?: Record<string, string> } }
    | { ok: false; error: string } => {
    if (!selection) {
      return {
        ok: true,
        value: {
          ...(remoteCase.codexCommandProfileId !== undefined
            ? { codexCommandProfileId: remoteCase.codexCommandProfileId }
            : {}),
          ...(remoteCase.commands && Object.keys(remoteCase.commands).length > 0
            ? { commands: remoteCase.commands }
            : {}),
        },
      };
    }
    const profiles = ctx.store.getCodexCommandProfiles(codexProfileOwner(owner));
    if (selection.kind === 'profile' && !profiles.some((profile) => profile.id === selection.profileId)) {
      return { ok: false, error: 'Saved Codex command profile is unavailable' };
    }
    const { codex: _codex, ...otherCommands } = remoteCase.commands ?? {};
    const commands = selection.kind === 'custom' ? { ...otherCommands, codex: selection.command } : otherCommands;
    return {
      ok: true,
      value: {
        ...(selection.kind === 'profile' ? { codexCommandProfileId: selection.profileId } : {}),
        ...(Object.keys(commands).length > 0 ? { commands } : {}),
      },
    };
  };

  async function resolveAccessibleCase(req: FastifyRequest, name: string): Promise<CaseInfo | null> {
    const user = getAuthUser(req);
    const remoteCase = (await readRemoteCases(CODEMAN_CONFIG_DIR)).find(
      (item) => item.name === name && canAccessOwned(user, item.owner)
    );
    if (remoteCase) {
      const host = (await readRemoteHosts(CODEMAN_CONFIG_DIR)).find((item) => item.id === remoteCase.hostId);
      if (!host) return null;
      return {
        name,
        path: remoteDisplayPath({ username: host.username, host: host.host, path: remoteCase.remotePath }),
        hasClaudeMd: false,
        location: 'remote',
        remote: {
          hostId: host.id,
          host: host.host,
          username: host.username,
          path: remoteCase.remotePath,
          commands: remoteCase.commands ?? host.commands,
          codexCommandSelection: selectionMetadata(remoteCase, remoteCase.owner, ownerFor(req)),
        },
      };
    }

    const dockerCase = (await readDockerCases(CODEMAN_CONFIG_DIR)).find(
      (item) => item.name === name && canAccessOwned(user, item.owner)
    );
    if (dockerCase) {
      const host = (await readDockerHosts(CODEMAN_CONFIG_DIR)).find((item) => item.id === dockerCase.hostId);
      if (!host) return null;
      const container = dockerCase.container ?? dockerContainerName(dockerCase.name);
      return {
        name,
        path: dockerDisplayPath({ container, path: dockerCase.hostWorkspacePath }),
        hasClaudeMd: existsSync(join(dockerCase.hostWorkspacePath, 'CLAUDE.md')),
        location: 'docker',
        docker: {
          hostId: host.id,
          container,
          image: host.image,
          path: dockerCase.hostWorkspacePath,
          network: host.network ?? 'bridge',
        },
      };
    }

    const casePath = await resolveCasePath(name, user);
    if (!existsSync(casePath)) return null;
    const linked = casePath !== join(resolveCasesDir(user), name);
    return {
      name,
      path: casePath,
      hasClaudeMd: existsSync(join(casePath, 'CLAUDE.md')),
      ...(linked && { linked: true }),
    };
  }

  const validateCaseName = (req: FastifyRequest, name: string): boolean =>
    Boolean(validatePathWithinBase(name, resolveCasesDir(getAuthUser(req))));

  const readDefaultGroupResponse = async (req: FastifyRequest, name: string) => {
    const owner = ownerLayoutKey(ownerFor(req));
    const snapshot = await ctx.tabLayouts.getSnapshot(owner);
    const groups = snapshot.layout.groups.map(({ id, name: groupName }) => ({ id, name: groupName }));
    let groupId = ctx.store.getCaseDefaultGroup(owner, name);
    if (typeof groupId === 'string' && !groups.some((group) => group.id === groupId)) {
      ctx.store.setCaseDefaultGroup(owner, name, null);
      groupId = null;
    }
    return { groupId: groupId ?? null, groups };
  };

  // ═══════════════════════════════════════════════════════════════
  // Case CRUD (list, create, link, detail, fix-plan)
  // ═══════════════════════════════════════════════════════════════

  // ========== List Cases ==========

  app.get('/api/cases', async (req): Promise<CaseInfo[]> => {
    const cases: CaseInfo[] = [];
    const user = getAuthUser(req);
    const admin = isAdmin(req);
    // Non-admins enumerate their OWN case space; admins see the shared CASES_DIR.
    const listBase = resolveCasesDir(user);

    // Get cases from the user's (or shared) cases dir
    try {
      const entries = await fs.readdir(listBase, { withFileTypes: true });
      for (const e of entries) {
        if (e.isDirectory() && SAFE_CASE_NAME.test(e.name)) {
          cases.push({
            name: e.name,
            path: join(listBase, e.name),
            hasClaudeMd: existsSync(join(listBase, e.name, 'CLAUDE.md')),
            location: 'local',
          });
        }
      }
    } catch {
      // dir may not exist yet
    }

    // Linked cases (v1 registry has no owner) are admin-only in multi-user mode.
    const linkedCases = await readLinkedCases();
    const existingNames = new Set(cases.map((c) => c.name));
    if (admin) {
      for (const [name, path] of Object.entries(linkedCases)) {
        if (!existingNames.has(name) && SAFE_CASE_NAME.test(name) && existsSync(path)) {
          cases.push({
            name,
            path,
            hasClaudeMd: existsSync(join(path, 'CLAUDE.md')),
            linked: true,
            location: 'linked-local',
          });
        }
      }
    }

    // Get remote cases (owner-scoped; legacy no-owner = admin-only)
    const remoteHosts = await readRemoteHosts(CODEMAN_CONFIG_DIR);
    const remoteHostMap = new Map(remoteHosts.map((host) => [host.id, host]));
    for (const remoteCase of await readRemoteCases(CODEMAN_CONFIG_DIR)) {
      const host = remoteHostMap.get(remoteCase.hostId);
      if (!host || !SAFE_CASE_NAME.test(remoteCase.name)) continue;
      if (!admin && !canAccessOwned(user, remoteCase.owner)) continue;
      existingNames.add(remoteCase.name);
      const remoteCaseInfo: CaseInfo = {
        name: remoteCase.name,
        path: remoteDisplayPath({ username: host.username, host: host.host, path: remoteCase.remotePath }),
        hasClaudeMd: false,
        location: 'remote',
        remote: {
          hostId: host.id,
          host: host.host,
          username: host.username,
          path: remoteCase.remotePath,
          commands: remoteCase.commands ?? host.commands,
          codexCommandSelection: selectionMetadata(remoteCase, remoteCase.owner, ownerFor(req)),
        },
      };
      const existingIndex = cases.findIndex((item) => item.name === remoteCase.name);
      if (existingIndex === -1) {
        cases.push(remoteCaseInfo);
      } else {
        cases[existingIndex] = remoteCaseInfo;
      }
    }

    // Get docker cases
    const dockerHosts = await readDockerHosts(CODEMAN_CONFIG_DIR);
    const dockerHostMap = new Map(dockerHosts.map((host) => [host.id, host]));
    for (const dockerCase of await readDockerCases(CODEMAN_CONFIG_DIR)) {
      const host = dockerHostMap.get(dockerCase.hostId);
      if (!host || !SAFE_CASE_NAME.test(dockerCase.name)) continue;
      if (!admin && !canAccessOwned(user, dockerCase.owner)) continue;
      existingNames.add(dockerCase.name);
      const container = dockerCase.container ?? dockerContainerName(dockerCase.name);
      const dockerCaseInfo: CaseInfo = {
        name: dockerCase.name,
        path: dockerDisplayPath({ container, path: dockerCase.hostWorkspacePath }),
        hasClaudeMd: existsSync(join(dockerCase.hostWorkspacePath, 'CLAUDE.md')),
        location: 'docker',
        docker: {
          hostId: host.id,
          container,
          image: host.image,
          path: dockerCase.hostWorkspacePath,
          network: host.network ?? 'bridge',
        },
      };
      const existingIndex = cases.findIndex((item) => item.name === dockerCase.name);
      if (existingIndex === -1) {
        cases.push(dockerCaseInfo);
      } else {
        cases[existingIndex] = dockerCaseInfo;
      }
    }

    // Sort by persisted caseOrder from settings.json
    const settings = await readJsonConfig<Record<string, unknown>>(SETTINGS_PATH, 'settings', {});
    const caseOrder = Array.isArray(settings.caseOrder) ? (settings.caseOrder as string[]) : [];
    if (caseOrder.length > 0) {
      const orderMap = new Map(caseOrder.map((name, idx) => [name, idx]));
      cases.sort((a, b) => {
        const ai = orderMap.get(a.name) ?? Number.MAX_SAFE_INTEGER;
        const bi = orderMap.get(b.name) ?? Number.MAX_SAFE_INTEGER;
        return ai - bi;
      });
    }

    return cases;
  });

  app.post('/api/cases', async (req): Promise<ApiResponse<{ case: { name: string; path: string } }>> => {
    const { name, description } = parseBody(CreateCaseSchema, req.body);

    const casePath = validatePathWithinBase(name, resolveCasesDir(getAuthUser(req)));
    if (!casePath) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid case path');
    }

    if (existsSync(casePath)) {
      return createErrorResponse(ApiErrorCode.ALREADY_EXISTS, 'Case already exists');
    }

    try {
      mkdirSync(casePath, { recursive: true });
      mkdirSync(join(casePath, 'src'), { recursive: true });

      // Read settings to get custom template path
      const templatePath = await ctx.getDefaultClaudeMdPath();
      const claudeMd = generateClaudeMd(name, description || '', templatePath);
      writeFileSync(join(casePath, 'CLAUDE.md'), claudeMd);

      // Write .claude/settings.local.json with hooks for desktop notifications
      await writeHooksConfig(casePath);

      ctx.broadcast(SseEvent.CaseCreated, { name, path: casePath });

      return { success: true, data: { case: { name, path: casePath } } };
    } catch (err) {
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, getErrorMessage(err));
    }
  });

  // ========== Clone a repository as a case (issue #236) ==========

  /**
   * Ask a remote what it has, without cloning anything.
   *
   * Two jobs: tell the user whether the URL they typed can be cloned *anonymously*
   * (Codeman supplies no credentials, so "private" and "typo" both have to be
   * distinguishable from "fine"), and hand back the branch/tag lists so the ref
   * field is a picker instead of a guess.
   *
   * Always 200 with `reachable: false` on a dead remote — an unreachable URL is a
   * normal answer to a preflight, not a server error, and the UI renders the reason.
   */
  app.post(
    '/api/cases/clone-preflight',
    async (
      req,
      reply
    ): Promise<ApiResponse<{ parse: GitUrlParse; remote?: GitRemoteProbe; gitAvailable: boolean }>> => {
      const { repository } = parseBody(ClonePreflightSchema, req.body);
      const parsed = parseGitRepositoryUrl(repository);
      if (!parsed.cloneable) {
        return { success: true, data: { parse: parsed, gitAvailable: isGitAvailable() } };
      }
      if (parsed.transport === 'local' && isMultiUserMode() && !isAdmin(req)) {
        reply.code(403);
        return createErrorResponse(ApiErrorCode.FORBIDDEN, LOCAL_CLONE_ADMIN_ONLY);
      }
      if (!isGitAvailable()) {
        return { success: true, data: { parse: parsed, gitAvailable: false } };
      }
      const remote = await probeGitRemote(parsed.repository);
      return { success: true, data: { parse: parsed, remote, gitAvailable: true } };
    }
  );

  /**
   * Clone a repository into the caller's case space and register it as a normal
   * local case (issue #236).
   *
   * SYNCHRONOUS by design for v1: the request stays open for the whole clone
   * (bounded by `GIT_CLONE_TIMEOUT_MS`), so there is no job store, no polling and
   * no cancellation surface to get wrong. The `case:created` broadcast is what
   * makes that safe behind a proxy with its own idle timeout — a client whose
   * request died mid-clone still sees the case appear over SSE when git finishes.
   *
   * Deliberately NOT admin-gated in multi-user mode: unlike `/api/cases/link`,
   * this writes only inside the caller's own `resolveCasesDir`. The one exception
   * is a `local`-transport source, which would read through that boundary.
   *
   * Repository contents win over scaffolding: an existing CLAUDE.md is left
   * alone, and hooks are MERGED into whatever `.claude/settings.local.json` the
   * repo ships (`writeHooksConfig` preserves non-Codeman handlers). A repo that
   * ships its own hooks is reported back as a warning, because those run on the
   * user's machine the moment a session starts in the case.
   */
  app.post(
    '/api/cases/clone',
    async (
      req,
      reply
    ): Promise<
      ApiResponse<{
        case: { name: string; path: string };
        repository: string;
        ref?: string;
        provider: string;
        warnings: string[];
      }>
    > => {
      const { name, repository, ref, shallow, description } = parseBody(CloneCaseSchema, req.body);
      const user = getAuthUser(req);

      const parsed = parseGitRepositoryUrl(repository);
      if (!parsed.cloneable) return createErrorResponse(ApiErrorCode.INVALID_INPUT, parsed.message);
      if (ref && !isSafeGitRef(ref)) {
        return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid branch or tag name');
      }
      if (parsed.transport === 'local' && isMultiUserMode() && !isAdmin(req)) {
        reply.code(403);
        return createErrorResponse(ApiErrorCode.FORBIDDEN, LOCAL_CLONE_ADMIN_ONLY);
      }
      if (!isGitAvailable()) {
        return createErrorResponse(
          ApiErrorCode.OPERATION_FAILED,
          'git is not installed on this machine (or not on the server’s PATH).'
        );
      }

      const casesDir = resolveCasesDir(user);
      const casePath = validatePathWithinBase(name, casesDir);
      if (!casePath) return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid case path');

      // Reject a duplicate name across EVERY case kind before invoking git, so a
      // clone can never be the thing that discovers the collision (it would have
      // spent minutes of network first, and git's own error is about a directory).
      const linkedCases = await readLinkedCases();
      const dockerCases = await readDockerCases(CODEMAN_CONFIG_DIR);
      const remoteCases = await readRemoteCases(CODEMAN_CONFIG_DIR);
      if (
        existsSync(casePath) ||
        linkedCases[name] ||
        dockerCases.some((item) => item.name === name) ||
        remoteCases.some((item) => item.name === name)
      ) {
        return createErrorResponse(ApiErrorCode.ALREADY_EXISTS, 'Case already exists');
      }

      // git creates the leaf, not necessarily the case space above it.
      try {
        mkdirSync(casesDir, { recursive: true });
      } catch (err) {
        return createErrorResponse(ApiErrorCode.OPERATION_FAILED, getErrorMessage(err));
      }

      const clone = await cloneRepository({
        repository: parsed.repository,
        destination: casePath,
        ...(ref ? { ref } : {}),
        ...(shallow ? { shallow: true } : {}),
      });
      if (!clone.ok) {
        const code =
          clone.failure.code === 'NOT_FOUND'
            ? ApiErrorCode.NOT_FOUND
            : clone.failure.code === 'DESTINATION_EXISTS'
              ? ApiErrorCode.ALREADY_EXISTS
              : clone.failure.code === 'REF_NOT_FOUND'
                ? ApiErrorCode.INVALID_INPUT
                : clone.failure.code === 'BUSY'
                  ? ApiErrorCode.RATE_LIMITED
                  : ApiErrorCode.OPERATION_FAILED;
        const detail = clone.failure.stderr
          ? `${clone.failure.message} (${gitDiagnosticLine(clone.failure.stderr)})`
          : clone.failure.message;
        return createErrorResponse(code, detail);
      }

      // Scaffold WITHOUT overwriting anything the repository shipped, and
      // WITHOUT writing through anything it shipped as a symlink.
      const warnings = [...parsed.warnings];
      try {
        // Presence via lstat, not existsSync: a repo-shipped CLAUDE.md SYMLINK
        // counts as "the repository ships its own" even when the link is
        // broken (existsSync follows links and reports a broken one as
        // absent), because writeFileSync would write THROUGH it to a
        // repository-chosen path outside the case.
        if (!lstatSync(join(casePath, 'CLAUDE.md'), { throwIfNoEntry: false })) {
          const templatePath = await ctx.getDefaultClaudeMdPath();
          const summary = description || `Cloned from ${parsed.repository}`;
          writeFileSync(join(casePath, 'CLAUDE.md'), generateClaudeMd(name, summary, templatePath));
        } else {
          warnings.push('Kept the repository’s own CLAUDE.md.');
        }
        if (repoShipsClaudeSettings(casePath)) {
          warnings.push(
            'This repository ships its own .claude/settings files. Codeman merged its hooks alongside them without removing anything — review them before starting a session, since repo-supplied hooks run on this machine.'
          );
        }
        // A repository can ship `.claude` (or the settings file) as a symlink
        // pointing anywhere on this machine; writeHooksConfig itself refuses
        // to write through those (settingsWriteBlocker in hooks-config.ts).
        // Checking here too turns that refusal into a user-visible warning.
        const hooksBlocker = await settingsWriteBlocker(casePath);
        if (hooksBlocker) {
          warnings.push(
            `Codeman hooks were NOT installed: ${hooksBlocker}. Codeman refuses to write through repository-controlled links; replace the link with a real file or directory if you want hooks in this case.`
          );
        } else {
          await writeHooksConfig(casePath);
        }
      } catch (err) {
        // The clone itself succeeded: keep the case and report the scaffolding
        // problem, rather than deleting a tree the user just waited for.
        warnings.push(`Case scaffolding was incomplete: ${getErrorMessage(err)}`);
      }

      ctx.broadcast(SseEvent.CaseCreated, { name, path: casePath });
      return {
        success: true,
        data: {
          case: { name, path: casePath },
          repository: parsed.repository,
          ...(ref ? { ref } : {}),
          provider: parsed.provider,
          warnings,
        },
      };
    }
  );

  // Hosts are machine-level infra config (ssh users/identity paths): non-admins get an
  // empty list in multi-user mode, matching the admin-only write side. No-op otherwise.
  app.get('/api/remote-hosts', async (req) =>
    isMultiUserMode() && !isAdmin(req) ? [] : readRemoteHosts(CODEMAN_CONFIG_DIR)
  );

  app.get('/api/cases/browse-local', async (req): Promise<ApiResponse<DirectoryBrowseResponse>> => {
    const { path: rawPath } = parseBody(BrowseDirectoryQuerySchema, req.query, 'Invalid directory browse query');
    const requestedPath = expandLocalBrowsePath(rawPath);
    if (!requestedPath.startsWith('/')) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Directory path must be absolute');
    }

    try {
      const realPath = await fs.realpath(requestedPath);
      if (isSensitivePath(realPath)) {
        return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Access to this directory is blocked');
      }
      const stat = await fs.stat(realPath);
      if (!stat.isDirectory()) {
        return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Path is not a directory');
      }
      const entries = await fs.readdir(realPath, { withFileTypes: true });
      const directories = entries
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
        .map((entry) => ({ name: entry.name, path: join(realPath, entry.name) }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return {
        success: true,
        data: {
          path: realPath,
          parentPath: localParentPath(realPath),
          entries: directories,
        },
      };
    } catch (err) {
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, getErrorMessage(err));
    }
  });

  // Hosts are machine-level resources: only admins may define them in multi-user mode.
  const adminOnly = (req: FastifyRequest, reply: { code: (n: number) => unknown }): ApiResponse<never> | null =>
    isAdmin(req)
      ? null
      : (reply.code(403), createErrorResponse(ApiErrorCode.FORBIDDEN, 'Admin only in multi-user mode'));

  // COD-105 — discover `codeman-*` tmux sessions already running on a remote
  // host (created by the remote's own Codeman, another instance, or this one)
  // so the operator can attach to one this Codeman didn't launch. Explicit
  // trigger only (Decision A): the frontend calls this on a "Discover" click,
  // never automatically on host select. listRemoteCodemanSessions never throws
  // (returns [] on unreachable/no-tmux/no-sessions) and is ssh-guarded under test.
  // Hosts are admin-only infra in multi-user mode, so discovery is too.
  app.get(
    '/api/remote-hosts/:hostId/sessions',
    async (req, reply): Promise<ApiResponse<{ sessions: RemoteSessionInfo[] }>> => {
      const denied = adminOnly(req, reply);
      if (denied) return denied;
      const { hostId } = req.params as { hostId: string };
      const host = (await readRemoteHosts(CODEMAN_CONFIG_DIR)).find((item) => item.id === hostId);
      if (!host) return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Remote host not found');
      const sessions = await listRemoteCodemanSessions(host);
      return { success: true, data: { sessions } };
    }
  );

  app.get('/api/remote-hosts/:hostId/directories', async (req): Promise<ApiResponse<DirectoryBrowseResponse>> => {
    const { hostId } = req.params as { hostId: string };
    const { path: rawPath } = parseBody(BrowseDirectoryQuerySchema, req.query, 'Invalid directory browse query');
    const remotePath = rawPath || '/';
    if (!remotePath.startsWith('/')) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Remote path must be absolute');
    }

    const host = (await readRemoteHosts(CODEMAN_CONFIG_DIR)).find((item) => item.id === hostId);
    if (!host) return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Remote host not found');

    try {
      const entries = await listRemoteDirectories(host, remotePath);
      return {
        success: true,
        data: {
          path: posixPath.normalize(remotePath),
          parentPath: remoteParentPath(remotePath),
          entries,
        },
      };
    } catch (err) {
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, getErrorMessage(err));
    }
  });

  app.post('/api/remote-hosts/verify', async (req): Promise<ApiResponse<{ ok: boolean }>> => {
    const host = parseBody(RemoteHostSchema, req.body);
    const result = await checkRemoteSshAccess(host);
    if (!result.ok) {
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, result.error || 'Could not verify SSH access');
    }
    return { success: true, data: { ok: true } };
  });

  app.post('/api/remote-hosts', async (req, reply): Promise<ApiResponse<{ host: unknown }>> => {
    const denied = adminOnly(req, reply);
    if (denied) return denied;
    const host = parseBody(RemoteHostSchema, req.body);
    const hosts = await readRemoteHosts(CODEMAN_CONFIG_DIR);
    if (hosts.some((item) => item.id === host.id)) {
      return createErrorResponse(ApiErrorCode.ALREADY_EXISTS, 'Remote host already exists');
    }
    await writeRemoteHosts(CODEMAN_CONFIG_DIR, [...hosts, host]);
    return { success: true, data: { host } };
  });

  app.put('/api/remote-hosts/:id', async (req, reply): Promise<ApiResponse<{ host: unknown }>> => {
    const denied = adminOnly(req, reply);
    if (denied) return denied;
    const { id } = req.params as { id: string };
    const host = parseBody(RemoteHostSchema, { ...(req.body as object), id });
    const hosts = await readRemoteHosts(CODEMAN_CONFIG_DIR);
    const index = hosts.findIndex((item) => item.id === id);
    if (index === -1) return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Remote host not found');
    const next = [...hosts];
    next[index] = host;
    await writeRemoteHosts(CODEMAN_CONFIG_DIR, next);
    return { success: true, data: { host } };
  });

  app.delete('/api/remote-hosts/:id', async (req, reply): Promise<ApiResponse<{ id: string }>> => {
    const denied = adminOnly(req, reply);
    if (denied) return denied;
    const { id } = req.params as { id: string };
    const cases = await readRemoteCases(CODEMAN_CONFIG_DIR);
    if (cases.some((item) => item.hostId === id)) {
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, 'Remote host is still used by remote cases');
    }
    const hosts = await readRemoteHosts(CODEMAN_CONFIG_DIR);
    await writeRemoteHosts(
      CODEMAN_CONFIG_DIR,
      hosts.filter((item) => item.id !== id)
    );
    return { success: true, data: { id } };
  });

  app.post('/api/cases/remote-link', async (req): Promise<ApiResponse<{ case: unknown }>> => {
    const input = parseBody(RemoteCaseLinkSchema, req.body);
    const selection = applyCodexSelection({ commands: input.commands }, input.codexCommandSelection, ownerFor(req));
    if (!selection.ok) return createErrorResponse(ApiErrorCode.OPERATION_FAILED, selection.error);
    const { commands: _commands, codexCommandSelection: _codexCommandSelection, ...remoteInput } = input;
    const remoteCase = { ...remoteInput, ...selection.value, type: 'remote' as const, owner: ownerFor(req) };
    const hosts = await readRemoteHosts(CODEMAN_CONFIG_DIR);
    const host = hosts.find((item) => item.id === remoteCase.hostId);
    if (!host) return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Remote host not found');

    const linkedCases = await readLinkedCases();
    const remoteCases = await readRemoteCases(CODEMAN_CONFIG_DIR);
    if (
      remoteCases.some((item) => item.name === remoteCase.name) ||
      linkedCases[remoteCase.name] ||
      existsSync(join(resolveCasesDir(getAuthUser(req)), remoteCase.name))
    ) {
      return createErrorResponse(ApiErrorCode.ALREADY_EXISTS, 'Case already exists');
    }

    await writeRemoteCases(CODEMAN_CONFIG_DIR, [...remoteCases, remoteCase]);
    ctx.broadcast(SseEvent.CaseLinked, { name: remoteCase.name, path: remoteCase.remotePath, type: 'remote' });
    return { success: true, data: { case: remoteCase } };
  });

  // ========== Docker hosts + docker cases (COD-Docker) ==========

  // Hosts are machine-level infra config (images/mounts/env): non-admins get an empty
  // list in multi-user mode, matching the admin-only write side. No-op otherwise.
  app.get('/api/docker-hosts', async (req) =>
    isMultiUserMode() && !isAdmin(req) ? [] : readDockerHosts(CODEMAN_CONFIG_DIR)
  );

  app.post('/api/docker-hosts', async (req, reply): Promise<ApiResponse<{ host: unknown }>> => {
    const denied = adminOnly(req, reply);
    if (denied) return denied;
    const host = parseBody(DockerHostSchema, req.body);
    const hosts = await readDockerHosts(CODEMAN_CONFIG_DIR);
    if (hosts.some((item) => item.id === host.id)) {
      return createErrorResponse(ApiErrorCode.ALREADY_EXISTS, 'Docker host already exists');
    }
    await writeDockerHosts(CODEMAN_CONFIG_DIR, [...hosts, host]);
    return { success: true, data: { host } };
  });

  app.put('/api/docker-hosts/:id', async (req, reply): Promise<ApiResponse<{ host: unknown }>> => {
    const denied = adminOnly(req, reply);
    if (denied) return denied;
    const { id } = req.params as { id: string };
    const host = parseBody(DockerHostSchema, { ...(req.body as object), id });
    const hosts = await readDockerHosts(CODEMAN_CONFIG_DIR);
    const index = hosts.findIndex((item) => item.id === id);
    if (index === -1) return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Docker host not found');
    const next = [...hosts];
    next[index] = host;
    await writeDockerHosts(CODEMAN_CONFIG_DIR, next);
    return { success: true, data: { host } };
  });

  app.delete('/api/docker-hosts/:id', async (req, reply): Promise<ApiResponse<{ id: string }>> => {
    const denied = adminOnly(req, reply);
    if (denied) return denied;
    const { id } = req.params as { id: string };
    const cases = await readDockerCases(CODEMAN_CONFIG_DIR);
    if (cases.some((item) => item.hostId === id)) {
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, 'Docker host is still used by docker cases');
    }
    const hosts = await readDockerHosts(CODEMAN_CONFIG_DIR);
    await writeDockerHosts(
      CODEMAN_CONFIG_DIR,
      hosts.filter((item) => item.id !== id)
    );
    return { success: true, data: { id } };
  });

  app.post(
    '/api/cases/docker-link',
    async (
      req
    ): Promise<
      ApiResponse<{ case: unknown; capsEnforced?: boolean; isDesktop?: boolean; imageBuilding?: boolean }>
    > => {
      const dockerCase = {
        ...parseBody(DockerCaseLinkSchema, req.body),
        type: 'docker' as const,
        owner: ownerFor(req),
      };
      const hosts = await readDockerHosts(CODEMAN_CONFIG_DIR);
      const host = hosts.find((item) => item.id === dockerCase.hostId);
      if (!host) return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Docker host not found');

      const linkedCases = await readLinkedCases();
      const dockerCases = await readDockerCases(CODEMAN_CONFIG_DIR);
      if (
        dockerCases.some((item) => item.name === dockerCase.name) ||
        linkedCases[dockerCase.name] ||
        existsSync(join(resolveCasesDir(getAuthUser(req)), dockerCase.name))
      ) {
        return createErrorResponse(ApiErrorCode.ALREADY_EXISTS, 'Case already exists');
      }

      // Confine the bind-mounted workspace to the caller's own space BEFORE creating it
      // (also removes the arbitrary-dir-creation primitive). No-op for admins/single-user.
      if (!isWorkingDirAllowed(getAuthUser(req), dockerCase.hostWorkspacePath)) {
        return createErrorResponse(ApiErrorCode.FORBIDDEN, 'hostWorkspacePath is outside your workspace');
      }

      // The workspace is a REAL host directory (bind-mounted into the container), so
      // create it now if missing. Scaffolding (.claude/settings.local.json + CLAUDE.md)
      // is written by quick-start on first launch, matching local-case behaviour.
      if (!existsSync(dockerCase.hostWorkspacePath)) {
        try {
          mkdirSync(dockerCase.hostWorkspacePath, { recursive: true });
        } catch (err) {
          return createErrorResponse(
            ApiErrorCode.OPERATION_FAILED,
            `Could not create workspace: ${getErrorMessage(err)}`
          );
        }
      }

      // Courtesy validation: docker daemon must be reachable. The base image is
      // auto-built on first use (default image) rather than being a link-time
      // blocker, so a missing image kicks off a background build instead of erroring.
      const availability = await checkDockerAvailable(host.engine);
      if (!availability.ok) {
        return createErrorResponse(
          ApiErrorCode.OPERATION_FAILED,
          availability.error || 'docker daemon is not available'
        );
      }
      const imageGate = await ensureCaseImage(ctx.broadcast, toSessionDocker(host, dockerCase), dockerCase.name);
      if (!imageGate.ok) {
        return createErrorResponse(ApiErrorCode.OPERATION_FAILED, imageGate.error);
      }

      await writeDockerCases(CODEMAN_CONFIG_DIR, [...dockerCases, dockerCase]);
      ctx.broadcast(SseEvent.CaseLinked, {
        name: dockerCase.name,
        path: dockerCase.hostWorkspacePath,
        type: 'docker',
      });
      return {
        success: true,
        data: {
          case: dockerCase,
          capsEnforced: availability.capsEnforced,
          isDesktop: availability.isDesktop,
          imageBuilding: imageGate.imageBuilding,
        },
      };
    }
  );

  // One-click "Run in Docker": create a NORMAL case (folder in CASES_DIR, scaffolded)
  // AND link it to a hardened container with default settings, auto-provisioning a
  // shared `default` docker host so the user never touches host/image/network fields.
  app.post(
    '/api/cases/docker-quickcreate',
    async (
      req
    ): Promise<
      ApiResponse<{ case: unknown; capsEnforced?: boolean; isDesktop?: boolean; imageBuilding?: boolean }>
    > => {
      const body = parseBody(DockerQuickCreateSchema, req.body);
      const { name, description } = body;
      const casePath = validatePathWithinBase(name, resolveCasesDir(getAuthUser(req)));
      if (!casePath) return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid case path');

      // Collision across every case kind.
      const linkedCases = await readLinkedCases();
      const dockerCases = await readDockerCases(CODEMAN_CONFIG_DIR);
      const remoteCases = await readRemoteCases(CODEMAN_CONFIG_DIR);
      if (
        existsSync(casePath) ||
        dockerCases.some((item) => item.name === name) ||
        remoteCases.some((item) => item.name === name) ||
        linkedCases[name]
      ) {
        return createErrorResponse(ApiErrorCode.ALREADY_EXISTS, 'Case already exists');
      }

      // The checkbox alone (no overrides) uses the shared `default` host; any tweaked
      // setting gets a dedicated per-case host so it never mutates the shared default.
      const hasOverrides = !!(
        body.image ||
        body.network ||
        body.networkName ||
        body.memory ||
        body.cpus ||
        body.gpus ||
        body.mountCredentials !== undefined
      );
      const resources: { memory?: string; cpus?: string } = {};
      if (body.memory) resources.memory = body.memory;
      if (body.cpus) resources.cpus = body.cpus;
      const desiredHost: DockerHost = {
        id: hasOverrides ? `q-${name}` : DEFAULT_DOCKER_HOST_ID,
        label: hasOverrides ? `Case: ${name}` : 'Default',
        image: body.image || DEFAULT_AGENT_IMAGE,
        network: body.network || 'bridge',
        ...(body.networkName ? { networkName: body.networkName } : {}),
        ...(Object.keys(resources).length ? { resources } : {}),
        ...(body.gpus ? { gpus: body.gpus } : {}),
        mountCredentials: body.mountCredentials ?? true,
        resumeOnStart: true,
        hooksEnabled: true,
      };
      const hosts = await readDockerHosts(CODEMAN_CONFIG_DIR);
      const existing = hosts.find((item) => item.id === desiredHost.id);
      // Reuse the shared default if present; create/refresh a per-case host for overrides.
      const host = existing && !hasOverrides ? existing : desiredHost;
      if (!existing) {
        await writeDockerHosts(CODEMAN_CONFIG_DIR, [...hosts, desiredHost]);
      } else if (hasOverrides) {
        await writeDockerHosts(
          CODEMAN_CONFIG_DIR,
          hosts.map((h) => (h.id === desiredHost.id ? desiredHost : h))
        );
      }

      // Probe the daemon BEFORE scaffolding so a missing docker surfaces a clear
      // error instead of leaving an orphaned case folder. The base image is NOT a
      // blocker: a missing default image auto-builds in the background on first use.
      const availability = await checkDockerAvailable(host.engine);
      if (!availability.ok) {
        return createErrorResponse(
          ApiErrorCode.OPERATION_FAILED,
          availability.error || 'docker daemon is not available'
        );
      }
      const dockerCase = {
        name,
        type: 'docker' as const,
        hostId: host.id,
        hostWorkspacePath: casePath,
        owner: ownerFor(req),
      };
      const imageGate = await ensureCaseImage(ctx.broadcast, toSessionDocker(host, dockerCase), name);
      if (!imageGate.ok) {
        return createErrorResponse(ApiErrorCode.OPERATION_FAILED, imageGate.error);
      }

      // Scaffold the case folder exactly like a normal case.
      try {
        mkdirSync(casePath, { recursive: true });
        mkdirSync(join(casePath, 'src'), { recursive: true });
        const templatePath = await ctx.getDefaultClaudeMdPath();
        writeFileSync(join(casePath, 'CLAUDE.md'), generateClaudeMd(name, description || '', templatePath));
        await writeHooksConfig(casePath);
      } catch (err) {
        return createErrorResponse(ApiErrorCode.OPERATION_FAILED, `Failed to create case: ${getErrorMessage(err)}`);
      }

      await writeDockerCases(CODEMAN_CONFIG_DIR, [...dockerCases, dockerCase]);
      ctx.broadcast(SseEvent.CaseCreated, { name, path: casePath });
      ctx.broadcast(SseEvent.CaseLinked, { name, path: casePath, type: 'docker' });
      return {
        success: true,
        data: {
          case: dockerCase,
          capsEnforced: availability.capsEnforced,
          isDesktop: availability.isDesktop,
          imageBuilding: imageGate.imageBuilding,
        },
      };
    }
  );

  // ========== Docker export / import ==========

  // Export a docker case to a portable bundle. Runs in the BACKGROUND (a full image
  // save can take minutes) and broadcasts docker:exportComplete / docker:exportFailed.
  app.post('/api/docker-cases/:name/export', async (req): Promise<ApiResponse<{ started: true; bundle: string }>> => {
    const { name } = req.params as { name: string };
    const { mode = 'full' } = parseBody(DockerExportSchema, req.body ?? {});
    const dockerCase = (await readDockerCases(CODEMAN_CONFIG_DIR)).find((item) => item.name === name);
    if (!dockerCase) return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Docker case not found');
    const host = (await readDockerHosts(CODEMAN_CONFIG_DIR)).find((item) => item.id === dockerCase.hostId);
    if (!host) return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Docker host not found');

    const sessionDocker = toSessionDocker(host, dockerCase);
    if (mode === 'full' && !sessionDocker.mountCredentials) {
      return createErrorResponse(
        ApiErrorCode.INVALID_INPUT,
        'full-image export is refused for a sealed container (its in-container login would ride the committed layer). Use a workspace-only export.'
      );
    }

    const timestamp = Date.now();
    const bundle = exportBundleName(name, timestamp, mode);
    // Fire-and-forget: the client watches for the SSE completion event.
    void exportDockerCase({
      docker: sessionDocker,
      caseName: name,
      timestamp,
      exportsDir: DOCKER_EXPORTS_DIR,
      mode,
      codemanVersion: APP_VERSION,
    })
      .then((result) => {
        ctx.broadcast(SseEvent.DockerExportComplete, {
          name,
          bundle: basename(result.bundlePath),
          sizeBytes: result.sizeBytes,
          mode,
        });
      })
      .catch((err) => {
        ctx.broadcast(SseEvent.DockerExportFailed, { name, mode, error: getErrorMessage(err) });
      });

    return { success: true, data: { started: true, bundle } };
  });

  app.get('/api/docker-exports', async (): Promise<ApiResponse<{ exports: unknown[] }>> => {
    return { success: true, data: { exports: await listDockerExports(DOCKER_EXPORTS_DIR) } };
  });

  // Download an export bundle (filename resolved WITHIN the exports dir — no traversal).
  app.get('/api/docker-exports/:filename', async (req, reply) => {
    const { filename } = req.params as { filename: string };
    if (!/^[a-zA-Z0-9._-]+\.tgz$/.test(filename)) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid bundle filename');
    }
    const full = join(DOCKER_EXPORTS_DIR, filename);
    if (!existsSync(full)) return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Export not found');
    reply.header('Content-Type', 'application/gzip');
    reply.header('Content-Disposition', `attachment; filename="${filename}"`);
    reply.header('X-Content-Type-Options', 'nosniff');
    return reply.send(createReadStream(full));
  });

  app.delete('/api/docker-exports/:filename', async (req): Promise<ApiResponse<{ filename: string }>> => {
    const { filename } = req.params as { filename: string };
    if (!/^[a-zA-Z0-9._-]+\.tgz$/.test(filename)) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid bundle filename');
    }
    const full = join(DOCKER_EXPORTS_DIR, filename);
    if (!existsSync(full)) return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Export not found');
    await fs.rm(full, { force: true });
    return { success: true, data: { filename } };
  });

  // Import a bundle (already present in the exports dir) into a NEW docker case.
  app.post('/api/docker-cases/import', async (req): Promise<ApiResponse<{ case: unknown }>> => {
    const { bundle, newCaseName, destWorkspacePath } = parseBody(DockerImportSchema, req.body);
    const bundlePath = join(DOCKER_EXPORTS_DIR, bundle);
    if (!existsSync(bundlePath)) return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Bundle not found in exports dir');

    // Name-collision guard across ALL case kinds.
    const linkedCases = await readLinkedCases();
    const dockerCases = await readDockerCases(CODEMAN_CONFIG_DIR);
    if (
      dockerCases.some((item) => item.name === newCaseName) ||
      linkedCases[newCaseName] ||
      existsSync(join(resolveCasesDir(getAuthUser(req)), newCaseName))
    ) {
      return createErrorResponse(ApiErrorCode.ALREADY_EXISTS, 'Case already exists');
    }

    // Import extracts a tar into destWorkspacePath (later becomes Session.workingDir):
    // confine it to the caller's own space. No-op for admins/single-user.
    if (!isWorkingDirAllowed(getAuthUser(req), destWorkspacePath)) {
      return createErrorResponse(ApiErrorCode.FORBIDDEN, 'destWorkspacePath is outside your workspace');
    }

    const timestamp = Date.now();
    let result;
    try {
      result = await importDockerBundle({
        bundlePath,
        destWorkspace: destWorkspacePath,
        engine: 'docker',
        timestamp,
        newCaseName,
      });
    } catch (err) {
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, `Import failed: ${getErrorMessage(err)}`);
    }

    // Create (or REFRESH) the dedicated docker host pointing at the quarantined
    // imported image (full mode) or the manifest's base image (workspace-only).
    // Refresh matters: after a case-delete + re-import of the same name, a stale
    // `imported-<name>` host would silently pin the PREVIOUS import's image tag.
    const hostId = `imported-${newCaseName}`;
    const hosts = await readDockerHosts(CODEMAN_CONFIG_DIR);
    const importedHost = {
      id: hostId,
      label: `Imported: ${newCaseName}`,
      engine: result.manifest.engine,
      image: result.importedImage ?? result.manifest.image,
      network: (['bridge', 'none', 'custom'].includes(result.manifest.network) ? result.manifest.network : 'bridge') as
        | 'bridge'
        | 'none'
        | 'custom',
    };
    await writeDockerHosts(
      CODEMAN_CONFIG_DIR,
      hosts.some((h) => h.id === hostId)
        ? hosts.map((h) => (h.id === hostId ? { ...h, ...importedHost } : h))
        : [...hosts, importedHost]
    );
    const newCase = {
      name: newCaseName,
      type: 'docker' as const,
      hostId,
      hostWorkspacePath: destWorkspacePath,
      containerWorkdir: result.manifest.containerWorkdir,
      owner: ownerFor(req),
    };
    await writeDockerCases(CODEMAN_CONFIG_DIR, [...dockerCases, newCase]);
    ctx.broadcast(SseEvent.DockerImportComplete, { name: newCaseName, path: destWorkspacePath, type: 'docker' });
    return { success: true, data: { case: newCase } };
  });

  // Recreate-on-drift confirm (docs/docker-cases-plan.md §4): remove the case
  // container so the next launch recreates it with the CURRENT host config. The
  // workspace + transcripts ride bind mounts and survive; the conversation resumes
  // via the case's lastClaudeSessionId. Refused while sessions of the case are live
  // (removal would yank the container out from under their panes).
  app.post(
    '/api/docker-cases/:name/recreate',
    async (req): Promise<ApiResponse<{ name: string; container: string }>> => {
      const { name } = req.params as { name: string };
      const dockerCase = (await readDockerCases(CODEMAN_CONFIG_DIR)).find((item) => item.name === name);
      if (!dockerCase) return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Docker case not found');
      const host = (await readDockerHosts(CODEMAN_CONFIG_DIR)).find((item) => item.id === dockerCase.hostId);
      if (!host) return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Docker host not found');
      const sessionDocker = toSessionDocker(host, dockerCase);

      for (const session of ctx.sessions.values()) {
        if (session.docker?.containerName === sessionDocker.containerName && session.pid) {
          return createErrorResponse(
            ApiErrorCode.CONFLICT,
            `Sessions of case "${name}" are still running — stop them first, then recreate the container.`
          );
        }
      }

      try {
        await removeDockerContainer(sessionDocker);
      } catch (err) {
        return createErrorResponse(
          ApiErrorCode.OPERATION_FAILED,
          `Failed to remove container: ${getErrorMessage(err)}`
        );
      }
      // Drop the per-container claude-config seed; it is regenerated at next launch.
      await fs
        .rm(join(dataPath('docker-seeds'), `${sessionDocker.containerName}.json`), { force: true })
        .catch(() => {});
      ctx.broadcast(SseEvent.DockerContainerRecreated, { name, container: sessionDocker.containerName });
      return { success: true, data: { name, container: sessionDocker.containerName } };
    }
  );

  // Link an existing folder as a case
  app.post('/api/cases/link', async (req, reply): Promise<ApiResponse<{ case: { name: string; path: string } }>> => {
    // Linking writes an arbitrary absolute path into the shared ownerless registry:
    // admin-only in multi-user mode (mirrors host CRUD + the admin-only GET listing).
    const denied = adminOnly(req, reply);
    if (denied) return denied;
    const { name, path: folderPath } = parseBody(LinkCaseSchema, req.body, 'Invalid request body');

    // Expand ~ to home directory
    const expandedPath = folderPath.startsWith('~') ? join(homedir(), folderPath.slice(1)) : folderPath;

    // Validate the folder exists
    if (!existsSync(expandedPath)) {
      return createErrorResponse(ApiErrorCode.NOT_FOUND, `Folder not found: ${expandedPath}`);
    }

    // Check if case name already exists in CASES_DIR
    const casePath = join(resolveCasesDir(getAuthUser(req)), name);
    if (existsSync(casePath)) {
      return createErrorResponse(ApiErrorCode.ALREADY_EXISTS, 'A case with this name already exists in codeman-cases.');
    }

    // Load existing linked cases
    const linkedCases = await readLinkedCases();

    // Check if name is already linked
    if (linkedCases[name]) {
      return createErrorResponse(
        ApiErrorCode.ALREADY_EXISTS,
        `Case "${name}" is already linked to ${linkedCases[name]}`
      );
    }

    // Save the linked case
    linkedCases[name] = expandedPath;
    try {
      const codemanDir = getDataDir();
      if (!existsSync(codemanDir)) {
        mkdirSync(codemanDir, { recursive: true });
      }
      await fs.writeFile(LINKED_CASES_FILE, JSON.stringify(linkedCases, null, 2));
      ctx.broadcast(SseEvent.CaseLinked, { name, path: expandedPath });
      return { success: true, data: { case: { name, path: expandedPath } } };
    } catch (err) {
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, getErrorMessage(err));
    }
  });

  app.put('/api/cases/:name', async (req): Promise<ApiResponse<{ case: CaseInfo }>> => {
    const { name: originalName } = req.params as { name: string };
    const update = parseBody(UpdateCaseSchema, req.body, 'Invalid case update');
    const user = getAuthUser(req);
    const casesDir = resolveCasesDir(user);
    const owner = ownerLayoutKey(ownerFor(req));

    if (!validatePathWithinBase(originalName, casesDir)) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid case name');
    }

    const nextName = update.name ?? originalName;
    if (!validatePathWithinBase(nextName, casesDir)) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid case name');
    }
    if (update.defaultGroupId !== undefined) {
      const snapshot = await ctx.tabLayouts.getSnapshot(owner);
      if (
        update.defaultGroupId !== null &&
        !snapshot.layout.groups.some((group) => group.id === update.defaultGroupId)
      ) {
        return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Default group does not exist');
      }
    }
    const persistDefaultGroupUpdate = () => {
      ctx.store.renameCaseDefaultGroup(owner, originalName, nextName);
      if (update.defaultGroupId !== undefined) ctx.store.setCaseDefaultGroup(owner, nextName, update.defaultGroupId);
    };

    const linkedCases = await readLinkedCases();
    const remoteCases = await readRemoteCases(CODEMAN_CONFIG_DIR);
    const dockerCases = await readDockerCases(CODEMAN_CONFIG_DIR);
    const nameExists = (candidate: string): boolean =>
      candidate !== originalName &&
      (Boolean(linkedCases[candidate]) ||
        remoteCases.some((item) => item.name === candidate) ||
        dockerCases.some((item) => item.name === candidate) ||
        existsSync(join(casesDir, candidate)));

    if (nameExists(nextName)) {
      return createErrorResponse(ApiErrorCode.ALREADY_EXISTS, 'Case already exists');
    }

    const remoteCaseIndex = remoteCases.findIndex(
      (item) => item.name === originalName && canAccessOwned(user, item.owner)
    );
    if (remoteCaseIndex !== -1) {
      const hostId = update.hostId ?? remoteCases[remoteCaseIndex].hostId;
      const remotePath = update.remotePath ?? remoteCases[remoteCaseIndex].remotePath;
      const currentRemoteCase = remoteCases[remoteCaseIndex];
      const selected = applyCodexSelection(
        update.commands === undefined ? currentRemoteCase : { ...currentRemoteCase, commands: update.commands },
        update.codexCommandSelection,
        currentRemoteCase.owner ?? ownerFor(req)
      );
      if (!selected.ok) return createErrorResponse(ApiErrorCode.OPERATION_FAILED, selected.error);
      const {
        codexCommandProfileId: _previousProfileId,
        commands: _previousCommands,
        ...remoteWithoutSelection
      } = currentRemoteCase;
      const commands = selected.value.commands;
      const host = (await readRemoteHosts(CODEMAN_CONFIG_DIR)).find((item) => item.id === hostId);
      if (!host) return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Remote host not found');

      const nextRemoteCase = {
        ...remoteWithoutSelection,
        name: nextName,
        hostId,
        remotePath,
        ...selected.value,
        ...(commands ? { commands } : {}),
        type: 'remote' as const,
      };
      const nextRemoteCases = [...remoteCases];
      nextRemoteCases[remoteCaseIndex] = nextRemoteCase;
      await writeRemoteCases(CODEMAN_CONFIG_DIR, nextRemoteCases);
      const caseInfo: CaseInfo = {
        name: nextName,
        path: remoteDisplayPath({ username: host.username, host: host.host, path: remotePath }),
        hasClaudeMd: false,
        location: 'remote',
        remote: {
          hostId: host.id,
          host: host.host,
          username: host.username,
          path: remotePath,
          commands: commands ?? host.commands,
          codexCommandSelection: selectionMetadata(nextRemoteCase, nextRemoteCase.owner, ownerFor(req)),
        },
      };
      persistDefaultGroupUpdate();
      ctx.broadcast(SseEvent.CaseLinked, { name: nextName, path: remotePath, type: 'remote-updated' });
      return { success: true, data: { case: caseInfo } };
    }

    const dockerCaseIndex = dockerCases.findIndex(
      (item) => item.name === originalName && canAccessOwned(user, item.owner)
    );
    if (dockerCaseIndex !== -1) {
      if (update.path || update.hostId || update.remotePath || update.commands || update.codexCommandSelection) {
        return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Docker case updates only support renaming');
      }
      const currentDockerCase = dockerCases[dockerCaseIndex];
      const nextDockerCase = {
        ...currentDockerCase,
        name: nextName,
        container: currentDockerCase.container ?? dockerContainerName(originalName),
      };
      const host = (await readDockerHosts(CODEMAN_CONFIG_DIR)).find((item) => item.id === nextDockerCase.hostId);
      if (!host) return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Docker host not found');
      const nextDockerCases = [...dockerCases];
      nextDockerCases[dockerCaseIndex] = nextDockerCase;
      await writeDockerCases(CODEMAN_CONFIG_DIR, nextDockerCases);
      const container = nextDockerCase.container ?? dockerContainerName(nextName);
      const caseInfo: CaseInfo = {
        name: nextName,
        path: dockerDisplayPath({ container, path: nextDockerCase.hostWorkspacePath }),
        hasClaudeMd: existsSync(join(nextDockerCase.hostWorkspacePath, 'CLAUDE.md')),
        location: 'docker',
        docker: {
          hostId: host.id,
          container,
          image: host.image,
          path: nextDockerCase.hostWorkspacePath,
          network: host.network ?? 'bridge',
        },
      };
      persistDefaultGroupUpdate();
      ctx.broadcast(SseEvent.CaseLinked, {
        name: nextName,
        path: nextDockerCase.hostWorkspacePath,
        type: 'docker-updated',
      });
      return { success: true, data: { case: caseInfo } };
    }

    if (linkedCases[originalName] && (!isMultiUserMode() || isAdmin(req))) {
      const nextPath = update.path ?? linkedCases[originalName];
      if (!existsSync(nextPath)) {
        return createErrorResponse(ApiErrorCode.NOT_FOUND, `Folder not found: ${nextPath}`);
      }
      delete linkedCases[originalName];
      linkedCases[nextName] = nextPath;
      await fs.writeFile(LINKED_CASES_FILE, JSON.stringify(linkedCases, null, 2));
      const caseInfo: CaseInfo = {
        name: nextName,
        path: nextPath,
        hasClaudeMd: existsSync(join(nextPath, 'CLAUDE.md')),
        linked: true,
        location: 'linked-local',
      };
      persistDefaultGroupUpdate();
      ctx.broadcast(SseEvent.CaseLinked, { name: nextName, path: nextPath, type: 'updated' });
      return { success: true, data: { case: caseInfo } };
    }

    const currentPath = join(casesDir, originalName);
    if (!existsSync(currentPath)) {
      return createErrorResponse(ApiErrorCode.NOT_FOUND, `Case "${originalName}" not found`);
    }
    if (update.path) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Managed case paths cannot be changed');
    }
    const nextPath = join(casesDir, nextName);
    if (nextName !== originalName) {
      await fs.rename(currentPath, nextPath);
    }
    const caseInfo: CaseInfo = {
      name: nextName,
      path: nextPath,
      hasClaudeMd: existsSync(join(nextPath, 'CLAUDE.md')),
      location: 'local',
    };
    persistDefaultGroupUpdate();
    ctx.broadcast(SseEvent.CaseCreated, { name: nextName, path: nextPath, type: 'updated' });
    return { success: true, data: { case: caseInfo } };
  });

  // ========== Delete / Unlink Case ==========

  app.delete('/api/cases/:name', async (req): Promise<ApiResponse<{ name: string }>> => {
    const { name } = req.params as { name: string };
    const user = getAuthUser(req);

    if (!validatePathWithinBase(name, resolveCasesDir(user))) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid case name');
    }

    // Fold ownership INTO the match (don't early-return): a non-owned same-named remote/
    // docker case is skipped so control falls through to the caller's own local delete.
    // canAccessOwned is all-true for admins/single-user, so flag-OFF stays byte-identical.
    const remoteCases = await readRemoteCases(CODEMAN_CONFIG_DIR);
    if (remoteCases.some((item) => item.name === name && canAccessOwned(user, item.owner))) {
      await writeRemoteCases(
        CODEMAN_CONFIG_DIR,
        remoteCases.filter((item) => !(item.name === name && canAccessOwned(user, item.owner)))
      );
      ctx.store.deleteCaseDefaultGroup(ownerLayoutKey(ownerFor(req)), name);
      ctx.broadcast(SseEvent.CaseDeleted, { name, type: 'remote-unlinked' });
      return { success: true, data: { name } };
    }

    const dockerCases = await readDockerCases(CODEMAN_CONFIG_DIR);
    const dockerCase = dockerCases.find((item) => item.name === name && canAccessOwned(user, item.owner));
    if (dockerCase) {
      await writeDockerCases(
        CODEMAN_CONFIG_DIR,
        dockerCases.filter((item) => item !== dockerCase)
      );
      ctx.store.deleteCaseDefaultGroup(ownerLayoutKey(ownerFor(req)), name);
      // Best-effort `docker rm -f` the per-case container (case-delete is the
      // explicit teardown that removes it; the bind-mounted workspace survives).
      const host = (await readDockerHosts(CODEMAN_CONFIG_DIR)).find((item) => item.id === dockerCase.hostId);
      if (host) {
        const sessionDocker = toSessionDocker(host, dockerCase);
        try {
          exec(buildDockerRemoveCommand(sessionDocker), { timeout: 15_000 }, () => {});
        } catch {
          /* best-effort — never blocks the unlink */
        }
        // Remove the per-container claude-config seed file (account metadata copy).
        await fs
          .rm(join(dataPath('docker-seeds'), `${sessionDocker.containerName}.json`), { force: true })
          .catch(() => {});
      }
      ctx.broadcast(SseEvent.CaseDeleted, { name, type: 'docker-unlinked' });
      return { success: true, data: { name } };
    }

    // Check linked cases first — unlink only, don't delete the actual directory.
    // Linked cases carry no owner (admin-only WRITE in multi-user mode), so a non-admin
    // must not unlink one either; skip so control falls through to their local delete.
    const linkedCases = await readLinkedCases();
    if (linkedCases[name] && (!isMultiUserMode() || isAdmin(req))) {
      delete linkedCases[name];
      try {
        await fs.writeFile(LINKED_CASES_FILE, JSON.stringify(linkedCases, null, 2));
        ctx.store.deleteCaseDefaultGroup(ownerLayoutKey(ownerFor(req)), name);
        ctx.broadcast(SseEvent.CaseDeleted, { name, type: 'unlinked' });
        return { success: true, data: { name } };
      } catch (err) {
        return createErrorResponse(ApiErrorCode.OPERATION_FAILED, getErrorMessage(err));
      }
    }

    // Case in CASES_DIR — delete the entire directory
    const casePath = join(resolveCasesDir(getAuthUser(req)), name);
    if (!existsSync(casePath)) {
      return createErrorResponse(ApiErrorCode.NOT_FOUND, `Case "${name}" not found`);
    }

    try {
      await fs.rm(casePath, { recursive: true, force: true });
      ctx.store.deleteCaseDefaultGroup(ownerLayoutKey(ownerFor(req)), name);
      ctx.broadcast(SseEvent.CaseDeleted, { name, type: 'deleted' });
      return { success: true, data: { name } };
    } catch (err) {
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, getErrorMessage(err));
    }
  });

  // ========== Reorder Cases ==========

  app.put('/api/cases/order', async (req): Promise<ApiResponse<{ order: string[] }>> => {
    const { order } = parseBody(CaseOrderSchema, req.body, 'Invalid order data');

    try {
      const dir = getDataDir();
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      let existing: Record<string, unknown> = {};
      try {
        existing = JSON.parse(await fs.readFile(SETTINGS_PATH, 'utf-8'));
      } catch {
        /* ignore */
      }
      const merged = { ...existing, caseOrder: order };
      await fs.writeFile(SETTINGS_PATH, JSON.stringify(merged, null, 2));
      ctx.broadcast(SseEvent.CaseOrderChanged, { order });
      return { success: true, data: { order } };
    } catch (err) {
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, getErrorMessage(err));
    }
  });

  app.get('/api/cases/:name/default-group', async (req) => {
    const { name } = req.params as { name: string };
    if (!validateCaseName(req, name)) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid case name');
    }
    if (!(await resolveAccessibleCase(req, name))) {
      return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Case not found');
    }
    return readDefaultGroupResponse(req, name);
  });

  app.put('/api/cases/:name/default-group', async (req) => {
    const { name } = req.params as { name: string };
    if (!validateCaseName(req, name)) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid case name');
    }
    if (!(await resolveAccessibleCase(req, name))) {
      return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Case not found');
    }
    const { groupId } = parseBody(CaseDefaultGroupSchema, req.body, 'Invalid default group');
    const owner = ownerLayoutKey(ownerFor(req));
    const snapshot = await ctx.tabLayouts.getSnapshot(owner);
    const groups = snapshot.layout.groups.map(({ id, name: groupName }) => ({ id, name: groupName }));
    if (groupId !== null && !groups.some((group) => group.id === groupId)) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Default group does not exist');
    }
    ctx.store.setCaseDefaultGroup(owner, name, groupId);
    return { groupId, groups };
  });

  app.get('/api/cases/:name', async (req) => {
    const { name } = req.params as { name: string };
    if (!validateCaseName(req, name)) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid case name');
    }
    const caseInfo = await resolveAccessibleCase(req, name);
    if (!caseInfo) {
      return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Case not found');
    }
    return caseInfo;
  });

  // Read @fix_plan.md from a case directory (for wizard to detect existing plans)
  app.get('/api/cases/:name/fix-plan', async (req) => {
    const { name } = req.params as { name: string };

    if (!validatePathWithinBase(name, resolveCasesDir(getAuthUser(req)))) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid case name');
    }

    // Get case path (check linked cases first, then CASES_DIR)
    const casePath = await resolveCasePath(name, getAuthUser(req));

    const fixPlanPath = join(casePath, '@fix_plan.md');

    if (!existsSync(fixPlanPath)) {
      return { exists: false, content: null, todos: [] };
    }

    try {
      const content = await fs.readFile(fixPlanPath, 'utf-8');

      // Parse todos from the content (similar to ralph-tracker's importFixPlanMarkdown)
      const todos: Array<{
        content: string;
        status: 'pending' | 'in_progress' | 'completed';
        priority: string | null;
      }> = [];
      const todoPattern = /^-\s*\[([ xX-])\]\s*(.+)$/;
      const p0HeaderPattern = /^##\s*(High Priority|Critical|P0|Critical Path)/i;
      const p1HeaderPattern = /^##\s*(Standard|P1|Medium Priority)/i;
      const p2HeaderPattern = /^##\s*(Nice to Have|P2|Low Priority)/i;
      const completedHeaderPattern = /^##\s*Completed/i;

      let currentPriority: string | null = null;
      let inCompletedSection = false;

      for (const line of content.split('\n')) {
        const trimmed = line.trim();

        if (p0HeaderPattern.test(trimmed)) {
          currentPriority = 'P0';
          inCompletedSection = false;
          continue;
        }
        if (p1HeaderPattern.test(trimmed)) {
          currentPriority = 'P1';
          inCompletedSection = false;
          continue;
        }
        if (p2HeaderPattern.test(trimmed)) {
          currentPriority = 'P2';
          inCompletedSection = false;
          continue;
        }
        if (completedHeaderPattern.test(trimmed)) {
          inCompletedSection = true;
          continue;
        }

        const match = trimmed.match(todoPattern);
        if (match) {
          const [, checkboxState, taskContent] = match;
          let status: 'pending' | 'in_progress' | 'completed';

          if (inCompletedSection || checkboxState === 'x' || checkboxState === 'X') {
            status = 'completed';
          } else if (checkboxState === '-') {
            status = 'in_progress';
          } else {
            status = 'pending';
          }

          todos.push({
            content: taskContent.trim(),
            status,
            priority: inCompletedSection ? null : currentPriority,
          });
        }
      }

      // Calculate stats in a single pass for better performance
      let pending = 0,
        inProgress = 0,
        completed = 0;
      for (const t of todos) {
        if (t.status === 'pending') pending++;
        else if (t.status === 'in_progress') inProgress++;
        else if (t.status === 'completed') completed++;
      }
      const stats = { total: todos.length, pending, inProgress, completed };

      return {
        exists: true,
        content,
        todos,
        stats,
      };
    } catch (err) {
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, `Failed to read @fix_plan.md: ${err}`);
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // Ralph Wizard Files (per-case prompt/result serving)
  // ═══════════════════════════════════════════════════════════════

  // ========== List Wizard Files ==========

  app.get('/api/cases/:caseName/ralph-wizard/files', async (req) => {
    const { caseName } = req.params as { caseName: string };
    if (!validatePathWithinBase(caseName, resolveCasesDir(getAuthUser(req)))) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid case name');
    }

    const casePath = await resolveCasePath(caseName, getAuthUser(req));

    const wizardDir = join(casePath, 'ralph-wizard');

    if (!existsSync(wizardDir)) {
      return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Ralph wizard directory not found');
    }

    // List all subdirectories and their files
    const files: Array<{ agentType: string; promptFile?: string; resultFile?: string }> = [];
    const entries = readdirSync(wizardDir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const agentDir = join(wizardDir, entry.name);
        const agentFiles: { agentType: string; promptFile?: string; resultFile?: string } = {
          agentType: entry.name,
        };

        if (existsSync(join(agentDir, 'prompt.md'))) {
          agentFiles.promptFile = `${entry.name}/prompt.md`;
        }
        if (existsSync(join(agentDir, 'result.json'))) {
          agentFiles.resultFile = `${entry.name}/result.json`;
        }

        if (agentFiles.promptFile || agentFiles.resultFile) {
          files.push(agentFiles);
        }
      }
    }

    return { success: true, data: { files, caseName } };
  });

  // Read a specific ralph-wizard file
  // Cache disabled to ensure fresh prompts when starting new plan generations
  app.get('/api/cases/:caseName/ralph-wizard/file/:filePath', async (req, reply) => {
    const { caseName, filePath } = req.params as { caseName: string; filePath: string };
    if (!validatePathWithinBase(caseName, resolveCasesDir(getAuthUser(req)))) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid case name');
    }

    // Prevent browser caching - prompts change between plan generations
    reply.header('Cache-Control', 'no-store, no-cache, must-revalidate');
    reply.header('Pragma', 'no-cache');
    reply.header('Expires', '0');

    const casePath = await resolveCasePath(caseName, getAuthUser(req));

    const wizardDir = join(casePath, 'ralph-wizard');

    // Decode the file path (it may be URL encoded)
    const decodedPath = decodeURIComponent(filePath);
    const fullPath = join(wizardDir, decodedPath);

    // Security: ensure path is within wizard directory
    const resolvedPath = resolve(fullPath);
    const resolvedWizard = resolve(wizardDir);
    if (!resolvedPath.startsWith(resolvedWizard)) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid file path');
    }

    let content: string;
    try {
      content = await fs.readFile(fullPath, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return createErrorResponse(ApiErrorCode.NOT_FOUND, 'File not found');
      }
      throw err;
    }
    const isJson = filePath.endsWith('.json');

    // Parse JSON content safely (may contain invalid JSON or unescaped control characters)
    let parsed: unknown = null;
    if (isJson) {
      try {
        parsed = JSON.parse(content);
      } catch {
        // Try repairing common JSON issues (unescaped control characters, trailing commas)
        try {
          let repaired = content;
          // Fix trailing commas before closing brackets
          repaired = repaired.replace(/,(\s*[\]}])/g, '$1');
          // Fix unescaped control characters within JSON strings
          repaired = repaired.replace(/"([^"\\]|\\.)*"/g, (match) => {
            return match
              .replace(/\n/g, '\\n')
              .replace(/\r/g, '\\r')
              .replace(/\t/g, '\\t')
              .replace(
                // eslint-disable-next-line no-control-regex
                /[\x00-\x1f]/g,
                (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`
              );
          });
          parsed = JSON.parse(repaired);
        } catch {
          // Still invalid - return null for parsed, content available as raw string
        }
      }
    }

    return {
      success: true,
      data: {
        content,
        filePath: decodedPath,
        isJson,
        parsed,
      },
    };
  });

  // ========== Skill Detail (for drawer) ==========

  app.get('/api/cases/:name/skill-detail', async (req): Promise<ApiResponse<SkillDetailResult>> => {
    const { name } = req.params as { name: string };
    try {
      const casePath = await resolveCasePath(name);
      if (!existsSync(casePath)) {
        return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Case not found');
      }
      return { success: true, data: await getSkillDetail(casePath) };
    } catch (err) {
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, getErrorMessage(err));
    }
  });

  app.post('/api/cases/:name/skill-sync', async (req): Promise<ApiResponse<SkillDetailResult>> => {
    const { name } = req.params as { name: string };
    try {
      const casePath = await resolveCasePath(name);
      if (!existsSync(casePath)) {
        return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Case not found');
      }
      await execAsync('skill-install sync', { cwd: casePath, timeout: 60000 });
      return { success: true, data: await getSkillDetail(casePath) };
    } catch (err) {
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, getErrorMessage(err));
    }
  });

  app.post('/api/cases/:name/skill-remove', async (req): Promise<ApiResponse<SkillDetailResult>> => {
    const { name } = req.params as { name: string };
    const body = req.body as { skillId?: string };
    const skillId = body?.skillId;
    if (!skillId || !SAFE_SKILL_ID.test(skillId)) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid skill ID');
    }
    try {
      const casePath = await resolveCasePath(name);
      if (!existsSync(casePath)) {
        return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Case not found');
      }
      await execFileAsync('skill-install', ['remove', skillId], { cwd: casePath, timeout: 30000 });
      return { success: true, data: await getSkillDetail(casePath) };
    } catch (err) {
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, getErrorMessage(err));
    }
  });

  // ========== Skill Catalog (pack browser) ==========

  app.get('/api/cases/:name/skill-catalog', async (req): Promise<ApiResponse<SkillCatalogResult>> => {
    const { name } = req.params as { name: string };
    try {
      const casePath = await resolveCasePath(name);
      if (!existsSync(casePath)) {
        return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Case not found');
      }
      const sources = await readSources();
      if (!sources.length) {
        return { success: true, data: { hasManifest: false, packs: [], individuals: [] } };
      }
      const catalog = await buildCatalog(sources);
      const entries = await classifyScope(sources, catalog, casePath);
      const klassMap = new Map(entries.map((e) => [`${e.kind}::${e.name}`, e.klass]));

      const packs: SkillCatalogPack[] = catalog.bundles.map((bundle) => {
        const allItems = [
          ...bundle.skills.map((n) => ({ kind: 'skill' as const, name: n })),
          ...bundle.agents.map((n) => ({ kind: 'agent' as const, name: n })),
          ...bundle.commands.map((n) => ({ kind: 'command' as const, name: n })),
        ];
        const installedCount = allItems.filter((it) => {
          const k = klassMap.get(`${it.kind}::${it.name}`);
          return k === 'linked-managed' || k === 'real';
        }).length;
        return {
          source: bundle.source,
          name: bundle.name,
          description: bundle.description,
          totalCount: allItems.length,
          installedCount,
        };
      });

      const individuals: SkillCatalogIndividual[] = catalog.entries
        .filter((e) => e.pack === null)
        .map((e) => ({
          kind: e.kind,
          name: e.name,
          source: e.source,
          klass: klassMap.get(`${e.kind}::${e.name}`) ?? 'available-managed',
        }));

      return { success: true, data: { hasManifest: true, packs, individuals } };
    } catch (err) {
      return createErrorResponse(
        ApiErrorCode.INTERNAL_ERROR,
        err instanceof Error ? err.message : 'Failed to read catalog'
      );
    }
  });

  // ========== Skill Add ==========

  const SAFE_SKILL_TARGET = /^[a-zA-Z0-9_][a-zA-Z0-9_./:@-]*$/;

  app.post('/api/cases/:name/skill-add', async (req): Promise<ApiResponse<SkillCatalogResult>> => {
    const { name } = req.params as { name: string };
    const { target } = (req.body as Record<string, unknown>) ?? {};
    if (!target || typeof target !== 'string' || !SAFE_SKILL_TARGET.test(target) || target.includes('..')) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Missing or unsafe target');
    }
    try {
      const casePath = await resolveCasePath(name);
      if (!existsSync(casePath)) {
        return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Case not found');
      }
      await execFileAsync('skill-install', ['add', target], { cwd: casePath, timeout: 60000 });
      const sources = await readSources();
      if (!sources.length) {
        return { success: true, data: { hasManifest: false, packs: [], individuals: [] } };
      }
      const catalog = await buildCatalog(sources);
      const entries = await classifyScope(sources, catalog, casePath);
      const klassMap = new Map(entries.map((e) => [`${e.kind}::${e.name}`, e.klass]));
      const packs: SkillCatalogPack[] = catalog.bundles.map((bundle) => {
        const allItems = [
          ...bundle.skills.map((n) => ({ kind: 'skill' as const, name: n })),
          ...bundle.agents.map((n) => ({ kind: 'agent' as const, name: n })),
          ...bundle.commands.map((n) => ({ kind: 'command' as const, name: n })),
        ];
        const installedCount = allItems.filter((it) => {
          const k = klassMap.get(`${it.kind}::${it.name}`);
          return k === 'linked-managed' || k === 'real';
        }).length;
        return {
          source: bundle.source,
          name: bundle.name,
          description: bundle.description,
          totalCount: allItems.length,
          installedCount,
        };
      });
      const individuals: SkillCatalogIndividual[] = catalog.entries
        .filter((e) => e.pack === null)
        .map((e) => ({
          kind: e.kind,
          name: e.name,
          source: e.source,
          klass: klassMap.get(`${e.kind}::${e.name}`) ?? 'available-managed',
        }));
      return { success: true, data: { hasManifest: true, packs, individuals } };
    } catch (err) {
      return createErrorResponse(
        ApiErrorCode.INTERNAL_ERROR,
        err instanceof Error ? err.message : 'Failed to add skill'
      );
    }
  });

  // ========== User-scope skills (App Settings → Skills) ==========

  async function getUserSkills(): Promise<UserSkillsResult> {
    const sources = await readSources();
    if (!sources.length) return { hasManifest: false, entries: [] };
    const catalog = await buildCatalog(sources);
    const raw = await classifyScope(sources, catalog, homedir());
    return { hasManifest: true, entries: raw.map((e) => toSkillEntry(e, sources)) };
  }

  app.get('/api/skills/user', async (): Promise<ApiResponse<UserSkillsResult>> => {
    try {
      return { success: true, data: await getUserSkills() };
    } catch (err) {
      return createErrorResponse(ApiErrorCode.INTERNAL_ERROR, getErrorMessage(err));
    }
  });

  app.post('/api/skills/user/add', async (req): Promise<ApiResponse<UserSkillsResult>> => {
    const { target } = req.body as { target?: string };
    if (!target || !SAFE_SKILL_TARGET.test(target) || target.includes('..')) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid skill target');
    }
    try {
      await execFileAsync('skill-install', ['--user', '--add', target], { timeout: 60000 });
      return { success: true, data: await getUserSkills() };
    } catch (err) {
      return createErrorResponse(ApiErrorCode.INTERNAL_ERROR, getErrorMessage(err));
    }
  });

  app.post('/api/skills/user/remove', async (req): Promise<ApiResponse<UserSkillsResult>> => {
    const { skillId } = req.body as { skillId?: string };
    if (!skillId || !SAFE_SKILL_ID.test(skillId)) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid skillId');
    }
    try {
      await execFileAsync('skill-install', ['--user', '--remove', skillId], { timeout: 60000 });
      return { success: true, data: await getUserSkills() };
    } catch (err) {
      return createErrorResponse(ApiErrorCode.INTERNAL_ERROR, getErrorMessage(err));
    }
  });

  // ========== Skill Adopt ==========

  interface AdoptSource {
    name: string;
    description: string;
    skillsDir: string; // prettified resolved path where skills land
  }

  const SAFE_SKILL_NAME = /^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/;
  const SAFE_SOURCE_NAME = /^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/;

  function expandHome(p: string): string {
    return p.startsWith('~/') || p === '~' ? join(homedir(), p.slice(2)) : p;
  }

  app.get('/api/skills/adopt-sources', async (): Promise<ApiResponse<{ sources: AdoptSource[] }>> => {
    try {
      const sources = await readSources();
      const result: AdoptSource[] = [];
      for (const src of sources) {
        const skillArtifact = src.artifacts['skill'];
        if (!skillArtifact?.root) continue;
        const srcPath = expandHome(src.path);
        if (!existsSync(srcPath)) continue;
        const skillsDir = join(srcPath, skillArtifact.root);
        if (!existsSync(skillsDir)) continue;
        result.push({ name: src.name, description: src.description, skillsDir: skillsDir.replace(homedir(), '~') });
      }
      return { success: true, data: { sources: result } };
    } catch (err) {
      return createErrorResponse(ApiErrorCode.INTERNAL_ERROR, getErrorMessage(err));
    }
  });

  app.post('/api/skills/user/adopt', async (req): Promise<ApiResponse<UserSkillsResult>> => {
    const body = req.body as Partial<{
      skillName: string;
      sourceName: string;
      forceOverwrite: boolean;
      codexSupport: boolean;
      codexYaml: string;
    }>;
    const { skillName, sourceName, forceOverwrite = false, codexSupport = false, codexYaml } = body;

    if (!skillName || !SAFE_SKILL_NAME.test(skillName))
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid skillName');
    if (!sourceName || !SAFE_SOURCE_NAME.test(sourceName))
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid sourceName');
    if (codexSupport && (!codexYaml || typeof codexYaml !== 'string'))
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'codexYaml required when codexSupport is true');

    try {
      const sources = await readSources();
      const source = sources.find((s) => s.name === sourceName);
      if (!source) return createErrorResponse(ApiErrorCode.NOT_FOUND, `Source '${sourceName}' not found`);

      const skillArtifact = source.artifacts['skill'];
      if (!skillArtifact?.root)
        return createErrorResponse(ApiErrorCode.INVALID_INPUT, `Source '${sourceName}' has no skill artifact config`);

      const destDir = join(expandHome(source.path), skillArtifact.root, skillName);

      // Verify the skill exists as a real file in user scope
      const catalog = await buildCatalog(sources);
      const userEntries = await classifyScope(sources, catalog, homedir());
      const entry = userEntries.find(
        (e) => (e.name === skillName || e.name === `${skillName}.md`) && e.klass === 'real'
      );
      if (!entry)
        return createErrorResponse(
          ApiErrorCode.NOT_FOUND,
          `'${skillName}' is not a real (non-symlink) skill in user scope`
        );

      // Conflict check
      if (existsSync(destDir) && !forceOverwrite)
        return createErrorResponse(
          ApiErrorCode.OPERATION_FAILED,
          `Destination already exists: ${destDir.replace(homedir(), '~')}`
        );

      // Create destination and copy content
      await fs.mkdir(destDir, { recursive: true });
      const realPath = entry.claudePath;
      const realStat = await fs.stat(realPath);
      if (realStat.isDirectory()) {
        await fs.cp(realPath, destDir, { recursive: true });
      } else {
        // Single .md file → place as SKILL.md
        const content = await fs.readFile(realPath, 'utf-8');
        await fs.writeFile(join(destDir, 'SKILL.md'), content, 'utf-8');
      }

      // Write agents/openai.yaml if Codex support requested
      if (codexSupport && codexYaml) {
        await fs.mkdir(join(destDir, 'agents'), { recursive: true });
        await fs.writeFile(join(destDir, 'agents', 'openai.yaml'), codexYaml, 'utf-8');
      }

      // Remove original real file/dir
      if (realStat.isDirectory()) {
        await fs.rm(realPath, { recursive: true, force: true });
      } else {
        await fs.unlink(realPath);
      }

      // Create Claude symlink: ~/.claude/skills/<skillName> → destDir
      const claudeSkillsDir = join(homedir(), '.claude', 'skills');
      const claudeLink = join(claudeSkillsDir, skillName);
      const claudeLinkMd = join(claudeSkillsDir, `${skillName}.md`);
      if (existsSync(claudeLinkMd)) await fs.unlink(claudeLinkMd);
      if (existsSync(claudeLink)) await fs.unlink(claudeLink);
      await fs.symlink(destDir, claudeLink);

      // Create Codex symlink: ~/.agents/skills/<skillName> → destDir
      if (codexSupport) {
        const codexSkillsDir = join(homedir(), '.agents', 'skills');
        await fs.mkdir(codexSkillsDir, { recursive: true });
        const codexLink = join(codexSkillsDir, skillName);
        if (existsSync(codexLink)) await fs.unlink(codexLink);
        await fs.symlink(destDir, codexLink);
      }

      // Update user-manifest.toml
      const manifestPath = join(expandHome('~/.config/skill-install'), 'user-manifest.toml');
      const manifest = await readUserManifest();
      const newEntry = `${sourceName}/${skillName}`;
      if (!manifest.skills.includes(newEntry)) {
        manifest.skills.push(newEntry);
        const tomlContent = stringifyToml({
          bundles: manifest.bundles,
          skills: manifest.skills,
          agents: manifest.agents,
          commands: manifest.commands,
          exclude: manifest.exclude,
        });
        await fs.writeFile(
          manifestPath,
          '# Managed by skill-install. Run `skill-install --user --sync` to apply.\n\n' + tomlContent
        );
      }

      return { success: true, data: await getUserSkills() };
    } catch (err) {
      return createErrorResponse(ApiErrorCode.INTERNAL_ERROR, getErrorMessage(err));
    }
  });

  // ========== Skill State (chip) ==========

  app.get('/api/cases/:name/skill-state', async (req): Promise<ApiResponse<SkillStateResult>> => {
    const { name } = req.params as { name: string };
    try {
      const casePath = await resolveCasePath(name);
      if (!existsSync(casePath)) {
        return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Case not found');
      }
      const sources = await readSources();
      if (!sources.length) {
        return { success: true, data: { hasManifest: false, installed: 0, missing: 0, drifted: 0, primaryPack: null } };
      }
      const catalog = await buildCatalog(sources);
      const entries = await classifyScope(sources, catalog, casePath);
      const { installed, missing, drifted } = summarize(entries);
      const primaryPack = catalog.entries[0]?.pack ?? catalog.entries[0]?.source ?? null;
      return { success: true, data: { hasManifest: true, installed, missing, drifted, primaryPack } };
    } catch (err) {
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, getErrorMessage(err));
    }
  });
}
