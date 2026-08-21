import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, rm, mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  parseEntry,
  readManifest,
  readUserManifest,
  readSources,
  buildCatalog,
  type SkillManifest,
  type SkillSource,
} from '../src/skill-install-reader.js';

describe('skill-install-reader', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'skill-install-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  // ---- parseEntry ----

  describe('parseEntry', () => {
    it('parses source/name (2-part)', () => {
      expect(parseEntry('claude-config/repo-audit')).toEqual({
        source: 'claude-config',
        pack: null,
        name: 'repo-audit',
      });
    });

    it('parses source/pack/name (3-part)', () => {
      expect(parseEntry('agent-library/pr-review-toolkit/code-reviewer')).toEqual({
        source: 'agent-library',
        pack: 'pr-review-toolkit',
        name: 'code-reviewer',
      });
    });

    it('returns null for single segment', () => {
      expect(parseEntry('single')).toBeNull();
    });

    it('returns null for 4+ segments', () => {
      expect(parseEntry('a/b/c/d')).toBeNull();
    });
  });

  // ---- readManifest ----

  describe('readManifest', () => {
    it('parses a full manifest', async () => {
      const p = path.join(tmpDir, '.skill-install.toml');
      await writeFile(
        p,
        `
bundles = ["packs/code-review"]
skills = ["claude-config/repo-audit", "claude-config/gh-pr-audit"]
agents = ["agent-library/pr-review-toolkit/code-reviewer"]
commands = []
exclude = ["agent-library/slow-agent"]
`
      );
      const manifest = await readManifest(p);
      expect(manifest.bundles).toEqual(['packs/code-review']);
      expect(manifest.skills).toEqual(['claude-config/repo-audit', 'claude-config/gh-pr-audit']);
      expect(manifest.agents).toEqual(['agent-library/pr-review-toolkit/code-reviewer']);
      expect(manifest.commands).toEqual([]);
      expect(manifest.exclude).toEqual(['agent-library/slow-agent']);
    });

    it('returns empty arrays for a missing file', async () => {
      const manifest = await readManifest(path.join(tmpDir, 'nonexistent.toml'));
      const empty: SkillManifest = { bundles: [], skills: [], agents: [], commands: [], exclude: [] };
      expect(manifest).toEqual(empty);
    });

    it('returns empty arrays for a manifest with no fields', async () => {
      const p = path.join(tmpDir, '.skill-install.toml');
      await writeFile(p, '# empty\n');
      const manifest = await readManifest(p);
      expect(manifest).toEqual({ bundles: [], skills: [], agents: [], commands: [], exclude: [] });
    });
  });

  // ---- readUserManifest ----

  describe('readUserManifest', () => {
    it('reads user-manifest.toml from config dir', async () => {
      await writeFile(
        path.join(tmpDir, 'user-manifest.toml'),
        `
bundles = []
skills = ["claude-config/update-notes"]
`
      );
      const manifest = await readUserManifest(tmpDir);
      expect(manifest.skills).toEqual(['claude-config/update-notes']);
    });

    it('returns empty manifest when user-manifest.toml is absent', async () => {
      const manifest = await readUserManifest(tmpDir);
      expect(manifest).toEqual({ bundles: [], skills: [], agents: [], commands: [], exclude: [] });
    });
  });

  // ---- readSources ----

  describe('readSources', () => {
    it('reads a simple source with skills_root', async () => {
      const sourcesDDir = path.join(tmpDir, 'sources.d');
      await mkdir(sourcesDDir);
      await writeFile(
        path.join(sourcesDDir, 'claude-config.toml'),
        `
name = "claude-config"
path = "${tmpDir}/repos/claude-config"
skills_root = "skills"
description = "Personal skill collection"
`
      );
      const sources = await readSources(tmpDir);
      expect(sources).toHaveLength(1);
      const src = sources[0];
      expect(src.name).toBe('claude-config');
      expect(src.description).toBe('Personal skill collection');
      expect(src.available).toBe(false); // path does not exist
      expect(src.artifacts.skill).toEqual({ root: 'skills' });
    });

    it('reads a source with [artifacts.kind] glob config', async () => {
      const sourcesDDir = path.join(tmpDir, 'sources.d');
      await mkdir(sourcesDDir);
      await writeFile(
        path.join(sourcesDDir, 'agent-library.toml'),
        `
name = "agent-library"
path = "${tmpDir}/repos/agent-library"
description = "Vendored agents"

[artifacts.agent]
glob = "plugins/*/agents/*.md"

[artifacts.skill]
glob = "plugins/*/skills/*"

[artifacts.command]
glob = "plugins/*/commands/*.md"
`
      );
      const sources = await readSources(tmpDir);
      expect(sources).toHaveLength(1);
      const src = sources[0];
      expect(src.artifacts.agent).toEqual({ glob: 'plugins/*/agents/*.md' });
      expect(src.artifacts.skill).toEqual({ glob: 'plugins/*/skills/*' });
      expect(src.artifacts.command).toEqual({ glob: 'plugins/*/commands/*.md' });
    });

    it('reads bundles from source TOML', async () => {
      const sourcesDDir = path.join(tmpDir, 'sources.d');
      await mkdir(sourcesDDir);
      await writeFile(
        path.join(sourcesDDir, 'packs.toml'),
        `
name = "packs"
path = "${tmpDir}/repos/packs"
description = "Curated packs"

[bundles.code-review]
description = "Pre-PR review agents"
agents = ["agent-library/pr-review-toolkit/code-reviewer"]
skills = ["claude-config/gh-pr-audit"]

[bundles.android-dev]
description = "Android project agents"
agents = ["agent-library/android-dev/mobile-developer"]
`
      );
      const sources = await readSources(tmpDir);
      expect(sources).toHaveLength(1);
      const src = sources[0];
      expect(src.bundles['code-review']).toEqual({
        description: 'Pre-PR review agents',
        agents: ['agent-library/pr-review-toolkit/code-reviewer'],
        skills: ['claude-config/gh-pr-audit'],
        commands: [],
      });
      expect(src.bundles['android-dev'].description).toBe('Android project agents');
    });

    it('returns empty array when sources.d/ is absent', async () => {
      const sources = await readSources(tmpDir);
      expect(sources).toEqual([]);
    });

    it('marks source available when path exists on disk', async () => {
      const repoPath = path.join(tmpDir, 'repos', 'mypkg');
      await mkdir(repoPath, { recursive: true });
      const sourcesDDir = path.join(tmpDir, 'sources.d');
      await mkdir(sourcesDDir);
      await writeFile(
        path.join(sourcesDDir, 'mypkg.toml'),
        `name = "mypkg"\npath = "${repoPath}"\ndescription = "test"\n`
      );
      const sources = await readSources(tmpDir);
      expect(sources[0].available).toBe(true);
    });
  });

  // ---- buildCatalog ----

  describe('buildCatalog', () => {
    it('returns empty catalog for unavailable sources', async () => {
      const src: SkillSource = {
        name: 'claude-config',
        path: '/nonexistent/path',
        description: '',
        available: false,
        artifacts: { skill: { root: 'skills' } },
        bundles: {},
      };
      const catalog = await buildCatalog([src]);
      expect(catalog.entries).toEqual([]);
      expect(catalog.bundles).toEqual([]);
    });

    it('discovers skill dirs under flat root layout', async () => {
      const repoPath = path.join(tmpDir, 'my-repo');
      const skillsRoot = path.join(repoPath, 'skills');
      await mkdir(skillsRoot, { recursive: true });
      await mkdir(path.join(skillsRoot, 'code-review'));
      await writeFile(path.join(skillsRoot, 'code-review', 'SKILL.md'), '# code-review');
      await mkdir(path.join(skillsRoot, 'line-edit'));

      const src: SkillSource = {
        name: 'my-repo',
        path: repoPath,
        description: '',
        available: true,
        artifacts: { skill: { root: 'skills' } },
        bundles: {},
      };
      const catalog = await buildCatalog([src]);
      const names = catalog.entries.map((e) => e.name);
      expect(names).toContain('code-review');
      expect(names).toContain('line-edit');
      expect(catalog.entries.every((e) => e.kind === 'skill')).toBe(true);
    });

    it('includes bundles from sources in catalog', async () => {
      const src: SkillSource = {
        name: 'packs',
        path: '/some/path',
        description: '',
        available: false,
        artifacts: {},
        bundles: {
          'code-review': { description: 'PR review', skills: ['x/y'], agents: [], commands: [] },
        },
      };
      const catalog = await buildCatalog([src]);
      expect(catalog.bundles).toHaveLength(1);
      expect(catalog.bundles[0]).toMatchObject({ source: 'packs', name: 'code-review' });
    });

    it('discovers single-file skills (.md) under flat root', async () => {
      const repoPath = path.join(tmpDir, 'flat-repo');
      await mkdir(repoPath);
      await writeFile(path.join(repoPath, 'my-skill.md'), '# my-skill');
      await writeFile(path.join(repoPath, 'README.md'), '# ignore this');

      const src: SkillSource = {
        name: 'flat-repo',
        path: repoPath,
        description: '',
        available: true,
        artifacts: { skill: { root: '.' } },
        bundles: {},
      };
      const catalog = await buildCatalog([src]);
      const names = catalog.entries.map((e) => e.name);
      expect(names).toContain('my-skill');
      expect(names).not.toContain('README');
    });
  });

  // ---- glob discovery (COD-342) ----

  describe('buildCatalog glob matching', () => {
    async function globSource(name: string, glob: string, files: string[]): Promise<SkillSource> {
      const repoPath = path.join(tmpDir, name);
      for (const rel of files) {
        const full = path.join(repoPath, rel);
        await mkdir(path.dirname(full), { recursive: true });
        await writeFile(full, '# fixture');
      }
      return {
        name,
        path: repoPath,
        description: '',
        available: true,
        artifacts: { skill: { glob } },
        bundles: {},
      };
    }

    it('matches wildcard segments against a nested layout', async () => {
      const src = await globSource('packs-repo', 'packs/*/*.md', [
        'packs/review/code-review.md',
        'packs/review/line-edit.md',
        'packs/other/thing.md',
        'packs/review/nested/deep.md',
        'top.md',
      ]);
      const catalog = await buildCatalog([src]);
      expect(catalog.entries.map((e) => `${e.pack}/${e.name}`).sort()).toEqual([
        'other/thing',
        'review/code-review',
        'review/line-edit',
      ]);
    });

    it('does not blow up on a segment carrying many wildcards', async () => {
      // The RegExp implementation compiled each `*` to a separate `[^/]*`, so a segment with
      // many of them backtracked catastrophically: 12 wildcards against a 32-character name
      // took 79 SECONDS on this box, and this runs per candidate file inside an await-free
      // loop — i.e. it wedges the whole event loop, not just one request.
      const name = 'a'.repeat(28);
      const src = await globSource('starry-repo', `${'*'.repeat(11)}x.md`, [`${name}.md`]);
      const started = Date.now();
      const catalog = await buildCatalog([src]);
      const elapsed = Date.now() - started;
      expect(catalog.entries).toEqual([]);
      expect(elapsed).toBeLessThan(1000);
    });

    it('treats `?` as a literal character rather than a RegExp quantifier', async () => {
      // `?` was missing from the escape set, so it survived into the compiled RegExp as a
      // quantifier. Two consequences: `ab?*` wrongly matched `ab`, and a leading `?` threw
      // `SyntaxError: Nothing to repeat` straight out of buildCatalog.
      const src = await globSource('question-repo', 'packs/ab?*.md', ['packs/ab.md', 'packs/ab?cd.md']);
      const catalog = await buildCatalog([src]);
      expect(catalog.entries.map((e) => e.name)).toEqual(['ab?cd']);
    });

    it('does not throw when a wildcard segment starts with a regex metacharacter', async () => {
      const src = await globSource('meta-repo', 'packs/?*.md', ['packs/?keep.md', 'packs/skip.md']);
      const catalog = await buildCatalog([src]);
      expect(catalog.entries.map((e) => e.name)).toEqual(['?keep']);
    });
  });
});
