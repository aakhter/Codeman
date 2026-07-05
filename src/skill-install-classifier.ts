/**
 * @fileoverview Skill install-state filesystem classifier — determines install state of each
 * catalog entry and disk-only artifacts at a given scope root. Pure reads only; no mutations.
 *
 * States: linked-managed (symlink → known source), available-managed (in catalog, not installed),
 * dangling (symlink → missing target), foreign (symlink → unknown target), real (not a symlink).
 *
 * @module skill-install-classifier
 */

import { lstat, readlink, readdir } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import type { ResolvedCatalog, SkillKind, SkillSource } from './skill-install-reader.js';

export type InstallClass = 'linked-managed' | 'available-managed' | 'dangling' | 'foreign' | 'real';

export interface InstallEntry {
  kind: SkillKind;
  name: string;
  source: string | null;
  pack: string | null;
  klass: InstallClass;
  claudePath: string;
  mirrorPath: string | null;
  target: string | null;
}

export interface InstallSummary {
  installed: number;
  missing: number;
  drifted: number;
}

const KINDS: SkillKind[] = ['skill', 'agent', 'command'];

function expandHome(p: string): string {
  return p.startsWith('~/') || p === '~' ? join(homedir(), p.slice(2)) : p;
}

function installDir(scopeRoot: string, kind: SkillKind): string {
  if (kind === 'skill') return join(scopeRoot, '.claude', 'skills');
  if (kind === 'agent') return join(scopeRoot, '.claude', 'agents');
  return join(scopeRoot, '.claude', 'commands');
}

function mirrorInstallDir(scopeRoot: string, kind: SkillKind): string | null {
  return kind === 'skill' ? join(scopeRoot, '.agents', 'skills') : null;
}

function resolveTarget(symlinkPath: string, target: string): string {
  return resolve(dirname(symlinkPath), target);
}

function isKnownSource(absTarget: string, sourcePaths: string[]): boolean {
  return sourcePaths.some((sp) => absTarget === sp || absTarget.startsWith(sp + '/'));
}

/** lstat both <dir>/<name> and <dir>/<name>.md; return the first found. */
async function probePath(dir: string, name: string): Promise<{ path: string; isSymlink: boolean } | null> {
  for (const candidate of [join(dir, name), join(dir, `${name}.md`)]) {
    try {
      const st = await lstat(candidate);
      return { path: candidate, isSymlink: st.isSymbolicLink() };
    } catch {
      // not found
    }
  }
  return null;
}

async function resolveSymlinkClass(
  path: string,
  sourcePaths: string[]
): Promise<{ klass: 'linked-managed' | 'dangling' | 'foreign'; target: string | null }> {
  let rawTarget: string;
  try {
    rawTarget = await readlink(path);
  } catch {
    return { klass: 'dangling', target: null };
  }
  const absTarget = resolveTarget(path, rawTarget);
  try {
    await lstat(absTarget);
  } catch {
    return { klass: 'dangling', target: rawTarget };
  }
  return {
    klass: isKnownSource(absTarget, sourcePaths) ? 'linked-managed' : 'foreign',
    target: rawTarget,
  };
}

/**
 * Classify all catalog entries for a scope, plus scan install dirs for unlisted artifacts.
 *
 * Catalog entries are checked first; the disk scan adds only entries not already claimed by
 * the catalog (by installed path) to avoid double-counting.
 */
export async function classifyScope(
  sources: SkillSource[],
  catalog: ResolvedCatalog,
  scopeRoot: string
): Promise<InstallEntry[]> {
  const root = expandHome(scopeRoot);
  const sourcePaths = sources.map((s) => s.path);

  const catalogEntries: InstallEntry[] = await Promise.all(
    catalog.entries.map(async (entry): Promise<InstallEntry> => {
      const dir = installDir(root, entry.kind);
      const mirrorBase = mirrorInstallDir(root, entry.kind);
      const defaultPath = join(dir, entry.name);
      const mirrorPath = mirrorBase ? join(mirrorBase, entry.name) : null;

      const found = await probePath(dir, entry.name);
      if (!found) {
        return {
          kind: entry.kind,
          name: entry.name,
          source: entry.source,
          pack: entry.pack,
          klass: 'available-managed',
          claudePath: defaultPath,
          mirrorPath,
          target: null,
        };
      }
      if (!found.isSymlink) {
        return {
          kind: entry.kind,
          name: entry.name,
          source: entry.source,
          pack: entry.pack,
          klass: 'real',
          claudePath: found.path,
          mirrorPath,
          target: null,
        };
      }
      const { klass, target } = await resolveSymlinkClass(found.path, sourcePaths);
      return {
        kind: entry.kind,
        name: entry.name,
        source: entry.source,
        pack: entry.pack,
        klass,
        claudePath: found.path,
        mirrorPath,
        target,
      };
    })
  );

  const catalogPaths = new Set(catalogEntries.map((e) => e.claudePath));
  const diskEntries: InstallEntry[] = [];

  for (const kind of KINDS) {
    const dir = installDir(root, kind);
    const mirrorBase = mirrorInstallDir(root, kind);
    let dirents: Dirent[];
    try {
      dirents = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const dirent of dirents) {
      const entryPath = join(dir, dirent.name);
      if (catalogPaths.has(entryPath)) continue;
      const name = dirent.name.endsWith('.md') ? dirent.name.slice(0, -3) : dirent.name;
      const mirrorPath = mirrorBase ? join(mirrorBase, name) : null;
      if (dirent.isSymbolicLink()) {
        const { klass, target } = await resolveSymlinkClass(entryPath, sourcePaths);
        diskEntries.push({ kind, name, source: null, pack: null, klass, claudePath: entryPath, mirrorPath, target });
      } else {
        diskEntries.push({
          kind,
          name,
          source: null,
          pack: null,
          klass: 'real',
          claudePath: entryPath,
          mirrorPath,
          target: null,
        });
      }
    }
  }

  return [...catalogEntries, ...diskEntries];
}

/** Aggregate install entries into summary counts for chip display. */
export function summarize(entries: InstallEntry[]): InstallSummary {
  let installed = 0,
    missing = 0,
    drifted = 0;
  for (const e of entries) {
    if (e.klass === 'linked-managed' || e.klass === 'real') installed++;
    else if (e.klass === 'available-managed') missing++;
    else drifted++;
  }
  return { installed, missing, drifted };
}
