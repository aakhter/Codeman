import { mkdtemp, mkdir, symlink, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { classifyScope, summarize } from '../src/skill-install-classifier.js';
import type { ResolvedCatalog, SkillSource } from '../src/skill-install-reader.js';

function makeSources(sourceDir: string): SkillSource[] {
  return [
    {
      name: 'my-source',
      path: sourceDir,
      description: 'test source',
      available: true,
      artifacts: { skill: { root: 'skills' } },
      bundles: {},
    },
  ];
}

function makeCatalog(entries: ResolvedCatalog['entries'] = []): ResolvedCatalog {
  return { entries, bundles: [] };
}

describe('classifyScope', () => {
  let tmp: string;
  let sourceDir: string;
  let scopeRoot: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'cod-200-test-'));
    sourceDir = join(tmp, 'my-source');
    scopeRoot = join(tmp, 'scope');
    await mkdir(join(sourceDir, 'skills'), { recursive: true });
    await mkdir(join(scopeRoot, '.claude', 'skills'), { recursive: true });
    await mkdir(join(scopeRoot, '.claude', 'agents'), { recursive: true });
    await mkdir(join(scopeRoot, '.claude', 'commands'), { recursive: true });
    await mkdir(join(scopeRoot, '.agents', 'skills'), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('available-managed: catalog entry not on disk', async () => {
    const catalog = makeCatalog([{ kind: 'skill', source: 'my-source', name: 'code-review', pack: null }]);
    const entries = await classifyScope(makeSources(sourceDir), catalog, scopeRoot);
    expect(entries).toHaveLength(1);
    expect(entries[0].klass).toBe('available-managed');
    expect(entries[0].name).toBe('code-review');
    expect(entries[0].target).toBeNull();
    expect(entries[0].mirrorPath).toContain('.agents/skills/code-review');
  });

  it('linked-managed: symlink pointing into a known source', async () => {
    const artDir = join(sourceDir, 'skills', 'code-review');
    await mkdir(artDir, { recursive: true });
    await symlink(artDir, join(scopeRoot, '.claude', 'skills', 'code-review'));
    const catalog = makeCatalog([{ kind: 'skill', source: 'my-source', name: 'code-review', pack: null }]);
    const entries = await classifyScope(makeSources(sourceDir), catalog, scopeRoot);
    expect(entries[0].klass).toBe('linked-managed');
    expect(entries[0].target).toBeTruthy();
  });

  it('dangling: symlink with missing target', async () => {
    const gone = join(sourceDir, 'skills', 'gone-skill');
    await symlink(gone, join(scopeRoot, '.claude', 'skills', 'gone-skill'));
    const catalog = makeCatalog([{ kind: 'skill', source: 'my-source', name: 'gone-skill', pack: null }]);
    const entries = await classifyScope(makeSources(sourceDir), catalog, scopeRoot);
    expect(entries[0].klass).toBe('dangling');
  });

  it('foreign: symlink to existing path not under any source', async () => {
    const external = join(tmp, 'external-skill');
    await mkdir(external, { recursive: true });
    await symlink(external, join(scopeRoot, '.claude', 'skills', 'external-skill'));
    const catalog = makeCatalog([{ kind: 'skill', source: 'my-source', name: 'external-skill', pack: null }]);
    const entries = await classifyScope(makeSources(sourceDir), catalog, scopeRoot);
    expect(entries[0].klass).toBe('foreign');
    expect(entries[0].target).toBeTruthy();
  });

  it('real: non-symlink file/dir in install path', async () => {
    await mkdir(join(scopeRoot, '.claude', 'skills', 'hand-rolled'), { recursive: true });
    const catalog = makeCatalog([{ kind: 'skill', source: 'my-source', name: 'hand-rolled', pack: null }]);
    const entries = await classifyScope(makeSources(sourceDir), catalog, scopeRoot);
    expect(entries[0].klass).toBe('real');
    expect(entries[0].target).toBeNull();
  });

  it('real: .md file discovered as real', async () => {
    await writeFile(join(scopeRoot, '.claude', 'skills', 'my-cmd.md'), '# cmd');
    const catalog = makeCatalog([{ kind: 'skill', source: 'my-source', name: 'my-cmd', pack: null }]);
    const entries = await classifyScope(makeSources(sourceDir), catalog, scopeRoot);
    expect(entries[0].klass).toBe('real');
    expect(entries[0].claudePath).toMatch(/my-cmd\.md$/);
  });

  it('disk scan: linked-managed entry not in catalog', async () => {
    const artDir = join(sourceDir, 'skills', 'unlisted');
    await mkdir(artDir, { recursive: true });
    await symlink(artDir, join(scopeRoot, '.claude', 'skills', 'unlisted'));
    const entries = await classifyScope(makeSources(sourceDir), makeCatalog(), scopeRoot);
    const e = entries.find((x) => x.name === 'unlisted');
    expect(e).toBeDefined();
    expect(e!.klass).toBe('linked-managed');
    expect(e!.source).toBeNull();
  });

  it('disk scan: foreign symlink not in catalog', async () => {
    const external = join(tmp, 'ext');
    await mkdir(external, { recursive: true });
    await symlink(external, join(scopeRoot, '.claude', 'skills', 'orphan'));
    const entries = await classifyScope(makeSources(sourceDir), makeCatalog(), scopeRoot);
    const e = entries.find((x) => x.name === 'orphan');
    expect(e!.klass).toBe('foreign');
  });

  it('disk scan: real dir not in catalog', async () => {
    await mkdir(join(scopeRoot, '.claude', 'skills', 'local-skill'), { recursive: true });
    const entries = await classifyScope(makeSources(sourceDir), makeCatalog(), scopeRoot);
    const e = entries.find((x) => x.name === 'local-skill');
    expect(e!.klass).toBe('real');
  });

  it('no duplicate entries when catalog matches disk', async () => {
    const artDir = join(sourceDir, 'skills', 'dup');
    await mkdir(artDir, { recursive: true });
    await symlink(artDir, join(scopeRoot, '.claude', 'skills', 'dup'));
    const catalog = makeCatalog([{ kind: 'skill', source: 'my-source', name: 'dup', pack: null }]);
    const entries = await classifyScope(makeSources(sourceDir), catalog, scopeRoot);
    expect(entries.filter((e) => e.name === 'dup')).toHaveLength(1);
  });

  it('agent kind uses .claude/agents dir, no mirrorPath', async () => {
    const catalog = makeCatalog([{ kind: 'agent', source: 'my-source', name: 'my-agent', pack: null }]);
    const entries = await classifyScope(makeSources(sourceDir), catalog, scopeRoot);
    expect(entries[0].claudePath).toContain('.claude/agents');
    expect(entries[0].mirrorPath).toBeNull();
    expect(entries[0].klass).toBe('available-managed');
  });

  it('command kind uses .claude/commands dir, no mirrorPath', async () => {
    const catalog = makeCatalog([{ kind: 'command', source: 'my-source', name: 'my-cmd', pack: null }]);
    const entries = await classifyScope(makeSources(sourceDir), catalog, scopeRoot);
    expect(entries[0].claudePath).toContain('.claude/commands');
    expect(entries[0].mirrorPath).toBeNull();
  });

  it('handles empty catalog and empty dirs', async () => {
    const entries = await classifyScope(makeSources(sourceDir), makeCatalog(), scopeRoot);
    expect(entries).toHaveLength(0);
  });
});

describe('summarize', () => {
  it('counts installed/missing/drifted correctly', () => {
    const entries = [
      { klass: 'linked-managed' },
      { klass: 'real' },
      { klass: 'available-managed' },
      { klass: 'available-managed' },
      { klass: 'dangling' },
      { klass: 'foreign' },
    ] as Parameters<typeof summarize>[0];
    const s = summarize(entries);
    expect(s.installed).toBe(2);
    expect(s.missing).toBe(2);
    expect(s.drifted).toBe(2);
  });

  it('all installed', () => {
    const s = summarize([{ klass: 'linked-managed' }, { klass: 'real' }] as Parameters<typeof summarize>[0]);
    expect(s).toEqual({ installed: 2, missing: 0, drifted: 0 });
  });

  it('empty', () => {
    expect(summarize([])).toEqual({ installed: 0, missing: 0, drifted: 0 });
  });
});
