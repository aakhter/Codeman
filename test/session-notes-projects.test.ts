import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SessionNotesProjects,
  SessionNotesProjectRegistryError,
  sessionNotesOwnerKey,
} from '../src/session-notes-projects.js';
import { SessionNotesStore } from '../src/session-notes-store.js';
import type { CaseInfo } from '../src/types/api.js';

const local = (name: string, path: string): CaseInfo => ({ name, path, location: 'linked-local' });
const remote = (name: string, hostId: string, path: string): CaseInfo => ({
  name,
  path,
  location: 'remote',
  remote: { hostId, host: 'host', username: 'user', path },
});
const docker = (name: string, hostId: string, container: string, path: string): CaseInfo => ({
  name,
  path: '/host',
  location: 'docker',
  docker: { hostId, container, path: '/host', containerWorkdir: path },
});

describe('session notes projects', () => {
  let root: string;
  let registry: SessionNotesProjects;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'notes-projects-'));
    registry = new SessionNotesProjects(root);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const session = (workingDir = '/work') => ({ id: 's1', workingDir });

  it('resolves exact roots and the most specific containing root', async () => {
    const cases = [local('Main', '/work'), local('Nested', '/work/nested')];
    expect((await registry.resolve('alice', session(), cases)).name).toBe('Main');
    expect((await registry.resolve('alice', session('/work/nested/src'), cases)).name).toBe('Nested');
  });
  it('requires path component boundaries and ignores similar worktree names', async () => {
    const project = await registry.resolve('alice', session('/work-other'), [local('Main', '/work')]);
    expect(project.source).toBe('directory');
    expect(project.root).toBe('/work-other');
  });
  it('prefers the chosen configured case over a nested root', async () => {
    const chosenCase = local('Main', '/work');
    expect(
      (
        await registry.resolve('alice', session('/work/nested'), [chosenCase, local('Nested', '/work/nested')], {
          chosenCase,
        })
      ).name
    ).toBe('Main');
  });
  it('retains the chosen launch project as historical after its configuration is removed', async () => {
    const chosenCase = local('Original', '/work');
    const original = await registry.resolve('alice', session(), [chosenCase]);
    const recovered = await registry.resolve('alice', session('/work/nested'), [local('Nested', '/work/nested')], {
      chosenCase,
    });
    expect(recovered).toMatchObject({ id: original.id, historical: true, name: 'Original' });
  });
  it('uses an established main repository root for a linked worktree', async () => {
    expect(
      (
        await registry.resolve('alice', session('/branches/feature'), [local('Main', '/work')], {
          mainRepositoryRoot: '/work',
        })
      ).name
    ).toBe('Main');
  });
  it('canonicalizes local symlinks and missing descendant paths', async () => {
    const real = join(root, 'real');
    await mkdir(real);
    await symlink(real, join(root, 'alias'));
    const project = await registry.resolve('alice', session(join(root, 'alias', 'missing')), [local('Main', real)]);
    expect(project.name).toBe('Main');
    expect(project.root).toBe(real);
  });
  it('keeps local, SSH hosts and container identities distinct', async () => {
    const a = await registry.resolve('alice', session(), [local('Local', '/work')]);
    const b = await registry.resolve('alice', { ...session(), remote: { hostId: 'h1', remotePath: '/work' } }, [
      remote('SSH1', 'h1', '/work'),
    ]);
    const c = await registry.resolve('alice', { ...session(), remote: { hostId: 'h2', remotePath: '/work' } }, [
      remote('SSH2', 'h2', '/work'),
    ]);
    const d = await registry.resolve(
      'alice',
      { ...session(), docker: { hostId: 'h1', containerName: 'c1', containerWorkdir: '/work' } },
      [docker('Docker1', 'h1', 'c1', '/work')]
    );
    const e = await registry.resolve(
      'alice',
      { ...session(), docker: { hostId: 'h1', containerName: 'c2', containerWorkdir: '/work' } },
      [docker('Docker2', 'h1', 'c2', '/work')]
    );
    expect(new Set([a.id, b.id, c.id, d.id, e.id]).size).toBe(5);
  });
  it('normalizes remote POSIX roots without local filesystem canonicalization', async () => {
    const project = await registry.resolve(
      'alice',
      { ...session('/host'), remote: { hostId: 'h1', remotePath: '/work/./src/../' } },
      [remote('SSH', 'h1', '/work/')]
    );
    expect(project.name).toBe('SSH');
    expect(project.root).toBe('/work');
  });
  it('persists fallback identity, configured rename, custom label and historical removal', async () => {
    const first = await registry.resolve('alice', session(), [local('Old', '/work')]);
    const renamed = await new SessionNotesProjects(root).resolve('alice', session(), [local('New', '/work')]);
    expect(renamed.id).toBe(first.id);
    expect(renamed.name).toBe('New');
    await registry.rename('alice', first.id, 'My label');
    expect((await registry.resolve('alice', session(), [local('Another', '/work')])).name).toBe('My label');
    await registry.sync('alice', []);
    expect((await registry.list('alice'))[0]).toMatchObject({ id: first.id, historical: true, name: 'My label' });
    const fallback = await registry.resolve('alice', session('/other'), []);
    expect((await new SessionNotesProjects(root).resolve('alice', session('/other'), [])).id).toBe(fallback.id);
  });
  it('isolates owners and safely maps raw authenticated usernames', async () => {
    const a = await registry.resolve('alice', session(), []);
    expect(await registry.list('bob')).toEqual([]);
    await expect(registry.rename('bob', a.id, 'stolen')).rejects.toThrow();
    const values = [undefined, '@single', 'a.b', 'a@b', 'a_b', 'A.B'].map(sessionNotesOwnerKey);
    expect(new Set(values).size).toBe(values.length);
    expect(values.every((value) => /^[a-zA-Z0-9_-]+$/.test(value))).toBe(true);
  });
  it('serializes independent registry writes without lost updates and uses private modes', async () => {
    await Promise.all(
      Array.from({ length: 6 }, (_, i) => new SessionNotesProjects(root).resolve('alice', session(`/p${i}`), []))
    );
    expect(await registry.list('alice')).toHaveLength(6);
    expect((await stat(join(root, 'alice', 'projects.json'))).mode & 0o777).toBe(0o600);
    expect((await stat(join(root, 'alice'))).mode & 0o777).toBe(0o700);
  });
  it('does not create history versions when resolving unchanged project metadata', async () => {
    await registry.resolve('alice', session(), []);
    const before = await readdir(join(root, 'alice', '.project-history'));
    await registry.resolve('alice', session(), []);
    expect(await readdir(join(root, 'alice', '.project-history'))).toEqual(before);
  });
  it('refuses owner and registry symlinks', async () => {
    await mkdir(join(root, 'outside'));
    await symlink(join(root, 'outside'), join(root, 'alice'));
    await expect(registry.list('alice')).rejects.toThrow(/Symlink/);
    await rm(join(root, 'alice'));
    await mkdir(join(root, 'alice'));
    await writeFile(join(root, 'outside', 'registry'), '[]');
    await symlink(join(root, 'outside', 'registry'), join(root, 'alice', 'projects.json'));
    await expect(registry.list('alice')).rejects.toThrow(/Symlink/);
  });
  it('retains malformed registry bytes instead of overwriting identities', async () => {
    await registry.resolve('alice', session(), []);
    await writeFile(join(root, 'alice', 'projects.json'), '{broken');
    await expect(registry.resolve('alice', session('/new'), [])).rejects.toBeInstanceOf(
      SessionNotesProjectRegistryError
    );
    await expect(registry.list('alice')).rejects.toMatchObject({ raw: '{broken' });
    expect(await readFile(join(root, 'alice', 'projects.json'), 'utf8')).toBe('{broken');
  });
  it('keeps the canonical registry readable and staged bytes recoverable when publication is interrupted', async () => {
    const first = await registry.resolve('alice', session(), []);
    const interrupted = new SessionNotesProjects(root, {
      checkpoint: () => {
        throw new Error('interrupted');
      },
    });
    await expect(interrupted.rename('alice', first.id, 'Changed')).rejects.toThrow('interrupted');
    expect((await new SessionNotesProjects(root).list('alice'))[0]).toMatchObject({ id: first.id, name: first.name });
    const history = await readdir(join(root, 'alice', '.project-history'));
    const stages = await Promise.all(
      history
        .filter((file) => file.endsWith('.staged'))
        .map((file) => readFile(join(root, 'alice', '.project-history', file), 'utf8'))
    );
    expect(stages.some((raw) => raw.includes('Changed'))).toBe(true);
  });
  it('reuses exact session and known conversation aliases after manual reassignment', async () => {
    const store = new SessionNotesStore(root);
    const p1 = await registry.resolve('alice', session(), []);
    const p2 = await registry.resolve('alice', session('/other'), []);
    const draft = store.create('alice', {
      projectId: p1.id,
      sessionId: 's1',
      sessionAliases: ['conversation1'],
      title: 'Note',
      sessionTitle: 'Original',
      workingDir: '/work',
      executionLocation: 'local',
    });
    const saved = (await store.save('alice', draft, 'content'))!;
    const moved = await registry.reassign('alice', saved, p2.id, store);
    expect(moved.metadata).toMatchObject({
      id: saved.metadata.id,
      projectId: p2.id,
      sessionId: 's1',
      workingDir: '/work',
      createdAt: saved.metadata.createdAt,
    });
    expect(moved.markdown).toBe('content');
    expect((await registry.findNotebook('alice', { id: 's1' }, store))?.metadata.projectId).toBe(p2.id);
    expect(
      (await registry.findNotebook('alice', { id: 'recovered', claudeSessionId: 'conversation1' }, store))?.metadata.id
    ).toBe(saved.metadata.id);
    expect(await registry.findNotebook('alice', { id: 'unrelated', sessionTitle: 'Original' }, store)).toBeNull();
  });
  it('refuses notebook reassignment to unknown or another owner project', async () => {
    const store = new SessionNotesStore(root);
    const p = await registry.resolve('bob', session(), []);
    const draft = store.create('alice', {
      projectId: 'old',
      sessionId: 's',
      sessionAliases: [],
      title: 'N',
      sessionTitle: 'S',
      workingDir: '/work',
      executionLocation: 'local',
    });
    const saved = (await store.save('alice', draft, 'body'))!;
    await expect(registry.reassign('alice', saved, p.id, store)).rejects.toThrow();
    expect((await store.read('alice', 'old', saved.metadata.id)).markdown).toBe('body');
  });
});
