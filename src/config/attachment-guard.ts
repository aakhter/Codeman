/**
 * @fileoverview Attachment path-guard configuration (COD-53).
 *
 * Governs which host files may be registered as cross-workspace attachments
 * and served to the browser. Two operator-facing knobs, both with safe
 * defaults:
 *
 *  1. **Blocked-path blocklist (DEFAULT, configurable).** Pre-populated with the
 *     shared secret-location blocklist (`isSensitivePath`) PLUS the directory
 *     trees `/root` and `/etc` (anything under them is blocked). The operator
 *     EXTENDS — never shrinks — this set with additional absolute directory
 *     trees via the settings key `attachmentBlockedPaths: string[]` and/or the
 *     env var `CODEMAN_ATTACHMENT_BLOCKED_PATHS` (comma-separated).
 *
 *  2. **Workspace confinement (OPTIONAL, default OFF).** When enabled, an
 *     attachment must resolve INSIDE the registering session's workingDir
 *     (reusing `validateSessionFilePath` containment semantics). This is
 *     strictly more restrictive than the blocklist and breaks intentional
 *     cross-workspace attachment (codeman-publish, the ~/.codeman review-card
 *     loop), so it is OFF by default. Toggle via settings
 *     `attachmentConfineToWorkspace: boolean` and/or env
 *     `CODEMAN_ATTACHMENT_CONFINE` (`1`/`true`).
 *
 *  3. **Trusted upload roots (OPTIONAL, default empty, ENV-ONLY).** The exact
 *     directories an admin may point a `.codeman-attachments` symlink at, via
 *     `CODEMAN_TRUSTED_ATTACHMENT_ROOTS` (comma-separated). Deliberately absent
 *     from `SettingsUpdateSchema` so the browser cannot add one, and parsed ONCE
 *     at startup (a change needs a restart). Matching is EXACT and fail-closed:
 *     the symlink's resolved target must EQUAL a root, re-checked on every upload
 *     and delete. ⚠️ Each entry must be absolute, canonical (an alias is refused;
 *     a trailing separator is normalized), a real directory, not blocked by (1),
 *     and a DEDICATED enclave — see `isDedicatedAttachmentEnclave`. Invalid
 *     entries are dropped with a path-free warning, never a startup failure.
 *
 * All paths passed to the predicates here MUST be absolute and symlink-resolved
 * (realpath) by the caller, mirroring `isSensitivePath`'s contract.
 *
 * @module config/attachment-guard
 */

import fs from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import type { AuthUser } from '../types/user.js';
import { isSensitivePath } from '../web/sensitive-path.js';
import { readJsonConfig, SETTINGS_PATH } from '../web/route-helpers.js';
import { getDataDir } from './instance.js';
import { getUserSpacesDir } from './multiuser.js';

/**
 * Directory trees blocked by default, IN ADDITION to the secret-location
 * blocklist in `isSensitivePath`. Anything resolving under one of these trees
 * is rejected. Pre-populated with the root account home and the system config
 * tree (which already partially overlaps `isSensitivePath`'s `/etc/shadow`
 * etc., but here we block the WHOLE tree).
 */
export const DEFAULT_BLOCKED_TREES: readonly string[] = ['/root', '/etc'];

/** Settings key carrying extra blocked directory trees (extends the defaults). */
export const ATTACHMENT_BLOCKED_PATHS_SETTING = 'attachmentBlockedPaths';

/** Settings key carrying the workspace-confinement toggle. */
export const ATTACHMENT_CONFINE_SETTING = 'attachmentConfineToWorkspace';

/** Resolved attachment-guard configuration. */
export interface AttachmentGuardConfig {
  /** Pre-populated default trees PLUS any operator extras. */
  blockedTrees: string[];
  /** Whether attachments must resolve inside the session workspace. */
  confineToWorkspace: boolean;
}

export type ResolvedUploadDirectory =
  | { kind: 'workspace'; canonicalDir: string }
  | { kind: 'trusted'; canonicalDir: string };

export class UploadDirectoryResolutionError extends Error {
  constructor(
    message: string,
    readonly statusCode: number = 403
  ) {
    super(message);
  }
}

let trustedAttachmentRootsSnapshot: Promise<readonly string[]> | undefined = parseTrustedAttachmentRoots();

function warnInvalidTrustedRoot(index: number, reason: string): void {
  console.warn(`[attachments] Ignoring CODEMAN_TRUSTED_ATTACHMENT_ROOTS entry ${index + 1}: ${reason}`);
}

/**
 * The trees a trusted root must not be, nor contain (COD-295). A trusted root is
 * where an admin's uploads LAND and everything under it becomes servable, so it
 * has to be a dedicated enclave. Accepting `/`, `$HOME`, `/home`, or any other
 * ancestor of the managed trees would quietly turn "trusted root" into "the whole
 * filesystem", which is the opposite of what the exact-root allowlist buys.
 *
 * Home is included on its own account: it is the ancestor of the managed trees in
 * a default layout, but `CODEMAN_DATA_DIR` / `CODEMAN_USER_SPACES_DIR` can move
 * those elsewhere, and home would still be far too broad.
 */
function managedTreesRequiringADedicatedRoot(): string[] {
  const home = homedir();
  return [home, getDataDir(), join(home, 'codeman-cases'), getUserSpacesDir()];
}

/**
 * Whether `canonicalRoot` (absolute, symlink-resolved, no trailing separator) is a
 * dedicated directory rather than one of the managed trees or an ancestor of one.
 * A directory INSIDE a managed tree is fine — `~/.codeman/shared-attachments` is a
 * legitimate enclave; `~/.codeman` itself is not.
 */
async function isDedicatedAttachmentEnclave(canonicalRoot: string): Promise<boolean> {
  for (const tree of managedTreesRequiringADedicatedRoot()) {
    // Compare against both the raw and the canonical form: the managed tree may not
    // exist yet (realpath throws) and may itself sit behind a symlink (/tmp on macOS).
    const forms = new Set([tree]);
    try {
      forms.add(await fs.realpath(tree));
    } catch {
      /* not created yet — the raw form is the best available comparison */
    }
    for (const form of forms) {
      if (pathIsInside(canonicalRoot, form)) return false;
    }
  }
  return true;
}

async function parseTrustedAttachmentRoots(): Promise<readonly string[]> {
  const raw = process.env.CODEMAN_TRUSTED_ATTACHMENT_ROOTS;
  if (!raw?.trim()) return [];

  const guard = await loadAttachmentGuardConfig();
  const accepted = new Set<string>();
  const entries = raw.split(',');
  for (let index = 0; index < entries.length; index += 1) {
    const raw = entries[index].trim();
    if (!raw) continue;
    if (!isAbsolute(raw)) {
      warnInvalidTrustedRoot(index, 'path must be absolute');
      continue;
    }
    // Normalize a trailing separator BEFORE the canonical comparison: `realpath`
    // strips it, so `/srv/enclave/` used to be rejected as "not canonical" and the
    // intended root was silently disabled (COD-295). Exact-root fail-closed
    // semantics are unchanged — a symlinked alias still fails the comparison.
    const candidate = normalizeTree(raw);
    try {
      const canonical = await fs.realpath(candidate);
      const stat = await fs.stat(canonical);
      if (canonical !== candidate) {
        warnInvalidTrustedRoot(index, 'path must already be canonical');
      } else if (!stat.isDirectory()) {
        warnInvalidTrustedRoot(index, 'path is not a directory');
      } else if (isBlockedAttachmentPath(canonical, guard.blockedTrees)) {
        warnInvalidTrustedRoot(index, 'path is blocked by attachment policy');
      } else if (!(await isDedicatedAttachmentEnclave(canonical))) {
        warnInvalidTrustedRoot(
          index,
          'path is not a dedicated directory (it is, or contains, the home directory or a Codeman-managed tree)'
        );
      } else {
        accepted.add(canonical);
      }
    } catch {
      warnInvalidTrustedRoot(index, 'path is unavailable');
    }
  }
  return Object.freeze([...accepted]);
}

/** Startup-scoped, environment-only exact allowlist for trusted upload roots. */
export function getTrustedAttachmentRoots(): Promise<readonly string[]> {
  trustedAttachmentRootsSnapshot ??= parseTrustedAttachmentRoots();
  return trustedAttachmentRootsSnapshot;
}

/** Test hook for changing process.env between isolated cases. */
export function resetTrustedAttachmentRootsForTests(): void {
  trustedAttachmentRootsSnapshot = undefined;
}

function pathIsInside(parent: string, child: string): boolean {
  const fromParent = relative(parent, child);
  return fromParent === '' || (fromParent !== '..' && !fromParent.startsWith(`..${sep}`) && !isAbsolute(fromParent));
}

function rejectedUploadDirectory(): UploadDirectoryResolutionError {
  return new UploadDirectoryResolutionError('.codeman-attachments is not an approved upload directory');
}

function rejectedUnconfiguredUploadDirectory(): UploadDirectoryResolutionError {
  return new UploadDirectoryResolutionError(
    'External .codeman-attachments requires an approved trusted attachment root'
  );
}

/**
 * Shared resolution for the sole local upload destination.
 *
 * `create` is a REQUIRED parameter rather than an option with a default: it is
 * the difference between a read-only request and one that mutates the user's
 * workspace, so every caller must state which it is (COD-296). Callers reach it
 * through the two named wrappers below, never directly.
 */
async function resolveUploadDirectory(
  workingDir: string,
  authUser: AuthUser,
  create: boolean
): Promise<ResolvedUploadDirectory | null> {
  let canonicalWorkspace: string;
  try {
    canonicalWorkspace = await fs.realpath(workingDir);
  } catch {
    throw rejectedUploadDirectory();
  }
  const attachmentsDir = join(canonicalWorkspace, '.codeman-attachments');

  let stat;
  try {
    stat = await fs.lstat(attachmentsDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw rejectedUploadDirectory();
    // COD-296: the directory simply is not there. Resolve-only callers get null
    // ("no uploads live here") — creating it would give a GET or a DELETE a
    // filesystem side effect in the user's workspace.
    if (!create) return null;
    try {
      await fs.mkdir(attachmentsDir);
    } catch (mkdirError) {
      if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') throw rejectedUploadDirectory();
    }
    try {
      stat = await fs.lstat(attachmentsDir);
    } catch {
      throw rejectedUploadDirectory();
    }
  }

  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    let canonicalDir: string;
    try {
      canonicalDir = await fs.realpath(attachmentsDir);
    } catch {
      throw rejectedUploadDirectory();
    }
    if (!pathIsInside(canonicalWorkspace, canonicalDir)) throw rejectedUploadDirectory();
    return { kind: 'workspace', canonicalDir };
  }

  if (!stat.isSymbolicLink() || authUser.role !== 'admin') throw rejectedUploadDirectory();

  try {
    const canonicalDir = await fs.realpath(attachmentsDir);
    const targetStat = await fs.stat(canonicalDir);
    const roots = await getTrustedAttachmentRoots();
    if (!targetStat.isDirectory()) {
      throw rejectedUploadDirectory();
    }
    if (!roots.includes(canonicalDir) || (await fs.realpath(canonicalDir)) !== canonicalDir) {
      throw rejectedUnconfiguredUploadDirectory();
    }
    return { kind: 'trusted', canonicalDir };
  } catch (err) {
    if (err instanceof UploadDirectoryResolutionError) throw err;
    throw rejectedUploadDirectory();
  }
}

/**
 * Resolve the local upload destination WITHOUT creating it — the read and delete
 * paths (attachment-history reconstruction, DELETE …/attachments/uploaded).
 *
 * Returns `null` when `.codeman-attachments/` does not exist, which callers must
 * treat as "no uploaded attachment here" (fail-closed: missing / 404). A
 * directory that DOES exist but is not an approved destination still throws, so
 * the security semantics are identical to {@link ensureLocalUploadDirectory}.
 */
export function resolveLocalUploadDirectory(
  workingDir: string,
  authUser: AuthUser
): Promise<ResolvedUploadDirectory | null> {
  return resolveUploadDirectory(workingDir, authUser, false);
}

/**
 * Resolve the local upload destination, creating it on first use — the UPLOAD
 * path only. This is the sole caller permitted to mutate the workspace, so
 * anything that is not an upload must use {@link resolveLocalUploadDirectory}.
 */
export async function ensureLocalUploadDirectory(
  workingDir: string,
  authUser: AuthUser
): Promise<ResolvedUploadDirectory> {
  const resolved = await resolveUploadDirectory(workingDir, authUser, true);
  // Unreachable in practice: with create=true the ENOENT branch either produces
  // a directory or throws. Kept as a real guard so the non-null return type is
  // proven rather than asserted.
  if (!resolved) throw rejectedUploadDirectory();
  return resolved;
}

/** Normalizes a tree prefix: trim, drop trailing separators (but keep root). */
function normalizeTree(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  // Strip trailing slashes so '/etc/' and '/etc' behave the same; never reduce
  // a bare separator to empty.
  const stripped = trimmed.replace(/[/\\]+$/, '');
  return stripped || trimmed[0];
}

/**
 * Returns true if `absPath` (absolute, symlink-resolved) is the tree itself or
 * lives under it. Uses path-separator-aware matching so `/etc` does NOT block
 * an unrelated `/etcetera/notes.md`.
 */
export function isUnderTree(absPath: string, tree: string): boolean {
  const t = normalizeTree(tree);
  if (!t) return false;
  if (absPath === t) return true;
  return absPath.startsWith(t.endsWith(sep) ? t : t + sep);
}

/** Parses the comma-separated env override into a list of normalized trees. */
function parseEnvBlockedTrees(): string[] {
  const raw = process.env.CODEMAN_ATTACHMENT_BLOCKED_PATHS;
  if (!raw) return [];
  return raw
    .split(',')
    .map(normalizeTree)
    .filter((t) => t.length > 0);
}

/** Parses the env confinement toggle (`1`/`true`/`yes`/`on`, case-insensitive). */
function parseEnvConfine(): boolean | undefined {
  const raw = process.env.CODEMAN_ATTACHMENT_CONFINE;
  if (raw === undefined) return undefined;
  return /^(1|true|yes|on)$/i.test(raw.trim());
}

/**
 * Loads the effective attachment-guard config by merging the pre-populated
 * defaults with settings.json and env overrides. Env wins over settings for the
 * confinement toggle; blocked-tree extras from BOTH sources are unioned on top
 * of the defaults (operators can only EXTEND, never shrink, the blocked set).
 */
export async function loadAttachmentGuardConfig(): Promise<AttachmentGuardConfig> {
  const settings = await readJsonConfig<Record<string, unknown>>(SETTINGS_PATH, 'settings.json', {});

  const settingsTrees = Array.isArray(settings[ATTACHMENT_BLOCKED_PATHS_SETTING])
    ? (settings[ATTACHMENT_BLOCKED_PATHS_SETTING] as unknown[])
        .filter((v): v is string => typeof v === 'string')
        .map(normalizeTree)
        .filter((t) => t.length > 0)
    : [];

  const blockedTrees = Array.from(new Set([...DEFAULT_BLOCKED_TREES, ...settingsTrees, ...parseEnvBlockedTrees()]));

  const envConfine = parseEnvConfine();
  const settingsConfine = settings[ATTACHMENT_CONFINE_SETTING] === true;
  const confineToWorkspace = envConfine ?? settingsConfine;

  return { blockedTrees, confineToWorkspace };
}

/**
 * Attachment-specific blocklist check. Builds on the shared `isSensitivePath`
 * base (secret locations, shared with `/api/download`) and ADDS the configured
 * directory trees (`/root`, `/etc`, plus operator extras). `absPath` must be
 * absolute and symlink-resolved.
 *
 * NOTE: this is intentionally a SUPERSET of `isSensitivePath` so `/api/download`
 * behavior is NOT changed — only attachment registration/serving uses this.
 */
export function isBlockedAttachmentPath(absPath: string, blockedTrees: readonly string[]): boolean {
  if (isSensitivePath(absPath)) return true;
  return blockedTrees.some((tree) => isUnderTree(absPath, tree));
}
