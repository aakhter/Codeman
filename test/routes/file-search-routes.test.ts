/**
 * @fileoverview Tests for GET /api/sessions/:id/files search + tree modes (COD-236).
 *
 * Unlike file-routes.test.ts these run against a REAL temp workspace
 * (fs.mkdtemp) so the walk, stat pool, excludeDirs, and hidden-file handling
 * are exercised end-to-end. Uses app.inject() — no real HTTP ports needed.
 * Port: N/A (app.inject doesn't open ports).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRouteTestHarness, type RouteTestHarness } from './_route-test-utils.js';
import { registerFileRoutes } from '../../src/web/routes/file-routes.js';

describe('file-routes GET /api/sessions/:id/files (search + tree)', () => {
  let harness: RouteTestHarness;
  let workspace: string;

  beforeEach(async () => {
    harness = await createRouteTestHarness(registerFileRoutes);
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'cod236-files-'));
    // Point the session at the real temp workspace.
    harness.ctx._session.workingDir = workspace;

    // Known tree:
    //   src/index.ts
    //   src/utils/widget.ts        (nested match target for "widget")
    //   README.md
    //   .secret                    (hidden file)
    //   node_modules/pkg/widget.ts (excluded dir — must never match)
    await fs.mkdir(path.join(workspace, 'src', 'utils'), { recursive: true });
    await fs.mkdir(path.join(workspace, 'node_modules', 'pkg'), { recursive: true });
    await fs.writeFile(path.join(workspace, 'src', 'index.ts'), 'export const x = 1;\n');
    await fs.writeFile(path.join(workspace, 'src', 'utils', 'widget.ts'), 'export const w = 2;\n');
    await fs.writeFile(path.join(workspace, 'README.md'), '# readme\n');
    await fs.writeFile(path.join(workspace, '.secret'), 'shh\n');
    await fs.writeFile(path.join(workspace, 'node_modules', 'pkg', 'widget.ts'), 'noise\n');
  });

  afterEach(async () => {
    await harness.app.close();
    await fs.rm(workspace, { recursive: true, force: true });
  });

  it('(a) ?q=<name> returns only matches with mode:search and an empty tree', async () => {
    const res = await harness.app.inject({
      method: 'GET',
      url: `/api/sessions/${harness.ctx._sessionId}/files?q=widget`,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.mode).toBe('search');
    expect(body.data.query).toBe('widget');
    expect(body.data.tree).toEqual([]);

    const paths = body.data.matches.map((m: { path: string }) => m.path);
    // The nested match is found...
    expect(paths).toContain(path.join('src', 'utils', 'widget.ts'));
    // ...but the excluded node_modules copy is NOT.
    expect(paths.some((p: string) => p.includes('node_modules'))).toBe(false);
    // Flat list — no nested children on match nodes.
    expect(body.data.matches.every((m: { children?: unknown }) => m.children === undefined)).toBe(true);
    expect(body.data.matchCount).toBe(body.data.matches.length);
  });

  it('search file matches carry a stat-ed size', async () => {
    const res = await harness.app.inject({
      method: 'GET',
      url: `/api/sessions/${harness.ctx._sessionId}/files?q=widget`,
    });
    const body = JSON.parse(res.body);
    const fileMatch = body.data.matches.find((m: { type: string }) => m.type === 'file');
    expect(fileMatch).toBeDefined();
    expect(typeof fileMatch.size).toBe('number');
    expect(fileMatch.size).toBeGreaterThan(0);
  });

  it('(b) no q returns the nested tree (regression) with populated file sizes', async () => {
    const res = await harness.app.inject({
      method: 'GET',
      url: `/api/sessions/${harness.ctx._sessionId}/files`,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data.tree)).toBe(true);

    // src/ is a directory node with nested children.
    const src = body.data.tree.find((n: { name: string }) => n.name === 'src');
    expect(src).toBeDefined();
    expect(src.type).toBe('directory');
    const utils = src.children.find((n: { name: string }) => n.name === 'utils');
    expect(utils).toBeDefined();
    const widget = utils.children.find((n: { name: string }) => n.name === 'widget.ts');
    expect(widget).toBeDefined();
    // Stat pool populated the size.
    expect(typeof widget.size).toBe('number');
    expect(widget.size).toBeGreaterThan(0);
  });

  it('(c) search respects excludeDirs and the hidden-file toggle', async () => {
    // Default (showHidden absent) — .secret must not appear.
    const hiddenOff = await harness.app.inject({
      method: 'GET',
      url: `/api/sessions/${harness.ctx._sessionId}/files?q=secret`,
    });
    const offBody = JSON.parse(hiddenOff.body);
    expect(offBody.data.matches.length).toBe(0);

    // showHidden=true — .secret is now searchable.
    const hiddenOn = await harness.app.inject({
      method: 'GET',
      url: `/api/sessions/${harness.ctx._sessionId}/files?q=secret&showHidden=true`,
    });
    const onBody = JSON.parse(hiddenOn.body);
    const names = onBody.data.matches.map((m: { name: string }) => m.name);
    expect(names).toContain('.secret');
  });

  it('(d) a glob q matches (anchored, case-insensitive)', async () => {
    const res = await harness.app.inject({
      method: 'GET',
      url: `/api/sessions/${harness.ctx._sessionId}/files?q=${encodeURIComponent('*.md')}`,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.mode).toBe('search');
    const names = body.data.matches.map((m: { name: string }) => m.name);
    expect(names).toContain('README.md');
    // .ts files must not match *.md
    expect(names.some((n: string) => n.endsWith('.ts'))).toBe(false);
  });

  it('matches directory entries by name in search mode', async () => {
    const res = await harness.app.inject({
      method: 'GET',
      url: `/api/sessions/${harness.ctx._sessionId}/files?q=utils`,
    });
    const body = JSON.parse(res.body);
    const dirMatch = body.data.matches.find((m: { type: string; name: string }) => m.name === 'utils');
    expect(dirMatch).toBeDefined();
    expect(dirMatch.type).toBe('directory');
    expect(dirMatch.children).toBeUndefined();
  });
});
