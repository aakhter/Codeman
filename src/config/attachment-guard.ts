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
 * All paths passed to the predicates here MUST be absolute and symlink-resolved
 * (realpath) by the caller, mirroring `isSensitivePath`'s contract.
 *
 * @module config/attachment-guard
 */

import fs from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import type { AuthUser } from '../types/user.js';
import { isSensitivePath } from '../web/sensitive-path.js';
import { readJsonConfig, SETTINGS_PATH } from '../web/route-helpers.js';

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

async function parseTrustedAttachmentRoots(): Promise<readonly string[]> {
  const raw = process.env.CODEMAN_TRUSTED_ATTACHMENT_ROOTS;
  if (!raw?.trim()) return [];

  const guard = await loadAttachmentGuardConfig();
  const accepted = new Set<string>();
  const entries = raw.split(',');
  for (let index = 0; index < entries.length; index += 1) {
    const candidate = entries[index].trim();
    if (!candidate) continue;
    if (!isAbsolute(candidate)) {
      warnInvalidTrustedRoot(index, 'path must be absolute');
      continue;
    }
    try {
      const canonical = await fs.realpath(candidate);
      const stat = await fs.stat(canonical);
      if (canonical !== candidate) {
        warnInvalidTrustedRoot(index, 'path must already be canonical');
      } else if (!stat.isDirectory()) {
        warnInvalidTrustedRoot(index, 'path is not a directory');
      } else if (isBlockedAttachmentPath(canonical, guard.blockedTrees)) {
        warnInvalidTrustedRoot(index, 'path is blocked by attachment policy');
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

/** Resolve the sole local upload destination used by both upload and deletion. */
export async function resolveLocalUploadDirectory(
  workingDir: string,
  authUser: AuthUser
): Promise<ResolvedUploadDirectory> {
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
    if (
      !targetStat.isDirectory() ||
      !roots.includes(canonicalDir) ||
      (await fs.realpath(canonicalDir)) !== canonicalDir
    ) {
      throw rejectedUploadDirectory();
    }
    return { kind: 'trusted', canonicalDir };
  } catch (err) {
    if (err instanceof UploadDirectoryResolutionError) throw err;
    throw rejectedUploadDirectory();
  }
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
