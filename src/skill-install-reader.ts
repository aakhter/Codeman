/**
 * @fileoverview Skill-install TOML config reader — reads sources.d/*.toml, project
 * .skill-install.toml manifests, and user-manifest.toml directly from disk, without
 * subprocess dependency on the skill-install CLI.
 *
 * Config dir defaults to ~/.config/skill-install (override via SKILL_INSTALL_CONFIG env var).
 * Entry format matches skill-install's parse_entry(): `source/name` or `source/pack/name`.
 *
 * @module skill-install-reader
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { homedir } from 'node:os';
import { parse } from 'smol-toml';

// .md files present in repos that are NOT skills (mirrors skill-install's META_MD_FILENAMES)
const META_MD = new Set([
  'README.md',
  'LICENSE.md',
  'CHANGELOG.md',
  'CONTRIBUTING.md',
  'AUTHORS.md',
  'CODE_OF_CONDUCT.md',
  'SECURITY.md',
  'SUPPORT.md',
  'INSTALL.md',
  'USAGE.md',
  'DEVELOPMENT.md',
  'NOTES.md',
  'TODO.md',
  'SOURCE.md',
  'CLAUDE.md',
  'AGENTS.md',
  'THIRD_PARTY_NOTICES.md',
]);

export type SkillKind = 'skill' | 'agent' | 'command';
const KINDS: SkillKind[] = ['skill', 'agent', 'command'];

export interface ArtifactDiscoveryConfig {
  root?: string;
  glob?: string;
}

export interface BundleSpec {
  description: string;
  skills: string[];
  agents: string[];
  commands: string[];
}

export interface SkillSource {
  name: string;
  path: string;
  description: string;
  available: boolean;
  artifacts: Partial<Record<SkillKind, ArtifactDiscoveryConfig>>;
  bundles: Record<string, BundleSpec>;
}

export interface SkillManifest {
  bundles: string[];
  skills: string[];
  agents: string[];
  commands: string[];
  exclude: string[];
}

export interface ParsedEntry {
  source: string;
  pack: string | null;
  name: string;
}

export interface CatalogEntry {
  kind: SkillKind;
  source: string;
  name: string;
  pack: string | null;
}

export interface ResolvedCatalog {
  entries: CatalogEntry[];
  bundles: Array<{ source: string; name: string } & BundleSpec>;
}

function defaultConfigDir(): string {
  const env = process.env['SKILL_INSTALL_CONFIG'];
  return env && env.trim() ? env : join(homedir(), '.config', 'skill-install');
}

/** Parse an entry string matching skill-install's parse_entry() logic. */
export function parseEntry(entry: string): ParsedEntry | null {
  const parts = entry.split('/');
  if (parts.length === 2) return { source: parts[0], pack: null, name: parts[1] };
  if (parts.length === 3) return { source: parts[0], pack: parts[1], name: parts[2] };
  return null;
}

function toStrArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string');
}

function parseArtifacts(data: Record<string, unknown>): Partial<Record<SkillKind, ArtifactDiscoveryConfig>> {
  // [artifacts.<kind>] blocks; legacy top-level skills_root → { skill: { root } }
  const raw =
    data['artifacts'] && typeof data['artifacts'] === 'object' && !Array.isArray(data['artifacts'])
      ? { ...(data['artifacts'] as Record<string, unknown>) }
      : {};

  if (!('skill' in raw) && typeof data['skills_root'] === 'string') {
    raw['skill'] = { root: data['skills_root'] };
  }
  if (Object.keys(raw).length === 0) {
    raw['skill'] = { root: '.' };
  }

  const result: Partial<Record<SkillKind, ArtifactDiscoveryConfig>> = {};
  for (const kind of KINDS) {
    const kc = raw[kind];
    if (!kc || typeof kc !== 'object' || Array.isArray(kc)) continue;
    const k = kc as Record<string, unknown>;
    const cfg: ArtifactDiscoveryConfig = {};
    if (typeof k['root'] === 'string') cfg.root = k['root'];
    if (typeof k['glob'] === 'string') cfg.glob = k['glob'];
    result[kind] = cfg;
  }
  return result;
}

function parseBundles(data: Record<string, unknown>): Record<string, BundleSpec> {
  const raw = data['bundles'];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const result: Record<string, BundleSpec> = {};
  for (const [name, bdata] of Object.entries(raw as Record<string, unknown>)) {
    if (!bdata || typeof bdata !== 'object' || Array.isArray(bdata)) continue;
    const b = bdata as Record<string, unknown>;
    result[name] = {
      description: typeof b['description'] === 'string' ? b['description'] : '',
      skills: toStrArray(b['skills']),
      agents: toStrArray(b['agents']),
      commands: toStrArray(b['commands']),
    };
  }
  return result;
}

/**
 * Read a manifest TOML file (.skill-install.toml or user-manifest.toml).
 * Returns an empty manifest if the file is absent or unreadable.
 */
export async function readManifest(manifestPath: string): Promise<SkillManifest> {
  let text: string;
  try {
    text = await readFile(manifestPath, 'utf-8');
  } catch {
    return { bundles: [], skills: [], agents: [], commands: [], exclude: [] };
  }
  const raw = parse(text) as Record<string, unknown>;
  return {
    bundles: toStrArray(raw['bundles']),
    skills: toStrArray(raw['skills']),
    agents: toStrArray(raw['agents']),
    commands: toStrArray(raw['commands']),
    exclude: toStrArray(raw['exclude']),
  };
}

/** Read the user-scope manifest from <configDir>/user-manifest.toml. */
export async function readUserManifest(configDir?: string): Promise<SkillManifest> {
  return readManifest(join(configDir ?? defaultConfigDir(), 'user-manifest.toml'));
}

/** Read all source definitions from <configDir>/sources.d/*.toml. */
export async function readSources(configDir?: string): Promise<SkillSource[]> {
  const dir = configDir ?? defaultConfigDir();
  const sourcesDDir = join(dir, 'sources.d');

  let files: string[];
  try {
    files = (await readdir(sourcesDDir)).filter((f) => f.endsWith('.toml')).sort();
  } catch {
    return [];
  }

  const sources: SkillSource[] = [];
  for (const file of files) {
    let text: string;
    try {
      text = await readFile(join(sourcesDDir, file), 'utf-8');
    } catch {
      continue;
    }
    const data = parse(text) as Record<string, unknown>;
    const name = typeof data['name'] === 'string' ? data['name'] : '';
    const rawPath = typeof data['path'] === 'string' ? data['path'] : '';
    if (!name || !rawPath) continue;

    const expanded = resolve(rawPath.replace(/^~(?=\/|$)/, homedir()));
    let available = false;
    try {
      await stat(expanded);
      available = true;
    } catch {
      // path does not exist on this machine
    }

    sources.push({
      name,
      path: expanded,
      description: typeof data['description'] === 'string' ? data['description'] : '',
      available,
      artifacts: parseArtifacts(data),
      bundles: parseBundles(data),
    });
  }
  return sources;
}

// ---- buildCatalog helpers ----

/** Check whether relPath matches a glob pattern (supports * per segment, no **). */
function matchGlob(pattern: string, relPath: string): boolean {
  const pat = pattern.split('/');
  const rel = relPath.split('/');
  if (pat.length !== rel.length) return false;
  return pat.every((seg, i) => {
    if (!seg.includes('*')) return seg === rel[i];
    const re = new RegExp('^' + seg.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*') + '$');
    return re.test(rel[i]);
  });
}

/** Return the path component matched by the first wildcard segment of the glob. */
function packFromGlob(pattern: string, relPath: string): string | null {
  const patParts = pattern.split('/');
  const relParts = relPath.split('/');
  for (let i = 0; i < patParts.length; i++) {
    if (patParts[i].includes('*')) return relParts[i] ?? null;
  }
  return null;
}

async function listFilesRecursive(dir: string, prefix: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const results: string[] = [];
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      results.push(...(await listFilesRecursive(join(dir, entry.name), rel)));
    } else {
      results.push(rel);
    }
  }
  return results;
}

async function discoverFlat(src: SkillSource, kind: SkillKind, rootRel: string): Promise<CatalogEntry[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(join(src.path, rootRel), { withFileTypes: true });
  } catch {
    return [];
  }
  const results: CatalogEntry[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      results.push({ kind, source: src.name, name: entry.name, pack: null });
    } else if (entry.name.endsWith('.md') && !META_MD.has(entry.name)) {
      results.push({ kind, source: src.name, name: entry.name.slice(0, -3), pack: null });
    }
  }
  return results;
}

async function discoverGlob(src: SkillSource, kind: SkillKind, globPattern: string): Promise<CatalogEntry[]> {
  const allFiles = await listFilesRecursive(src.path, '');
  const results: CatalogEntry[] = [];
  for (const rel of allFiles) {
    if (!matchGlob(globPattern, rel)) continue;
    const pack = packFromGlob(globPattern, rel);
    const base = basename(rel);
    const name = base.endsWith('.md') ? base.slice(0, -3) : base;
    results.push({ kind, source: src.name, name, pack });
  }
  return results;
}

/**
 * Build a ResolvedCatalog by scanning source paths on disk.
 * Unavailable sources contribute no entries but still expose their bundle metadata.
 */
export async function buildCatalog(sources: SkillSource[]): Promise<ResolvedCatalog> {
  const entries: CatalogEntry[] = [];
  const bundles: ResolvedCatalog['bundles'] = [];

  for (const src of sources) {
    for (const [name, spec] of Object.entries(src.bundles)) {
      bundles.push({ source: src.name, name, ...spec });
    }
    if (!src.available) continue;
    for (const kind of KINDS) {
      const cfg = src.artifacts[kind];
      if (!cfg) continue;
      if (cfg.glob) {
        entries.push(...(await discoverGlob(src, kind, cfg.glob)));
      } else if (cfg.root !== undefined) {
        entries.push(...(await discoverFlat(src, kind, cfg.root)));
      }
    }
  }

  return { entries, bundles };
}
