/**
 * TDD route tests for COD-65 GET/POST/DELETE /api/sessions/:id/sources.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRouteTestHarness } from './_route-test-utils.js';
import { registerSourceRoutes } from '../../src/web/routes/source-routes.js';

const SESSION_ID = 'test-session-1';

describe('source routes', () => {
  describe('GET /api/sessions/:id/sources', () => {
    it('returns empty list when session has no sources', async () => {
      const { app } = await createRouteTestHarness(registerSourceRoutes);
      const res = await app.inject({ method: 'GET', url: `/api/sessions/${SESSION_ID}/sources` });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.sources).toEqual([]);
    });

    it('returns 404 for unknown session', async () => {
      const { app } = await createRouteTestHarness(registerSourceRoutes);
      const res = await app.inject({ method: 'GET', url: '/api/sessions/no-such-session/sources' });
      expect(res.statusCode).toBe(404);
    });

    it('discovers source files from the workspace and retains non-file metadata', async () => {
      const { app, ctx } = await createRouteTestHarness(registerSourceRoutes);
      const workdir = await fs.mkdtemp(join(tmpdir(), 'codeman-source-routes-'));
      ctx._session.workingDir = workdir;
      await fs.mkdir(join(workdir, '.codeman-sources'));
      await fs.writeFile(join(workdir, '.codeman-sources', 'unregistered.pdf'), '%PDF-1.4');
      await fs.writeFile(join(workdir, '.codeman-sources', 'sibling.pdf'), '%PDF-1.4');

      try {
        await app.inject({
          method: 'POST',
          url: `/api/sessions/${SESSION_ID}/sources`,
          payload: { type: 'url', title: 'MDN Docs', url: 'https://developer.mozilla.org' },
        });
        await app.inject({
          method: 'POST',
          url: `/api/sessions/${SESSION_ID}/sources`,
          payload: { type: 'highlight', title: 'Key excerpt', content: 'Keep this.' },
        });

        const response = await app.inject({ method: 'GET', url: `/api/sessions/${SESSION_ID}/sources` });
        const sources = JSON.parse(response.body).data.sources;

        expect(sources).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: 'file',
              title: 'unregistered.pdf',
              relativePath: '.codeman-sources/unregistered.pdf',
            }),
            expect.objectContaining({ type: 'url', title: 'MDN Docs' }),
            expect.objectContaining({ type: 'highlight', title: 'Key excerpt' }),
          ])
        );
      } finally {
        await app.close();
        await fs.rm(workdir, { recursive: true, force: true });
      }
    });

    it('deletes the selected filesystem source without deleting sibling files', async () => {
      const { app, ctx } = await createRouteTestHarness(registerSourceRoutes);
      const workdir = await fs.mkdtemp(join(tmpdir(), 'codeman-source-routes-'));
      ctx._session.workingDir = workdir;
      await fs.mkdir(join(workdir, '.codeman-sources'));
      await fs.writeFile(join(workdir, '.codeman-sources', 'delete-me.pdf'), '%PDF-1.4');
      await fs.writeFile(join(workdir, '.codeman-sources', 'keep-me.pdf'), '%PDF-1.4');

      try {
        const listed = await app.inject({ method: 'GET', url: `/api/sessions/${SESSION_ID}/sources` });
        const source = JSON.parse(listed.body).data.sources.find(
          (item: { title: string }) => item.title === 'delete-me.pdf'
        );
        const response = await app.inject({
          method: 'DELETE',
          url: `/api/sessions/${SESSION_ID}/sources/${source.id}`,
        });

        expect(response.statusCode).toBe(200);
        await expect(fs.stat(join(workdir, '.codeman-sources', 'delete-me.pdf'))).rejects.toMatchObject({
          code: 'ENOENT',
        });
        await expect(fs.stat(join(workdir, '.codeman-sources', 'keep-me.pdf'))).resolves.toBeDefined();
      } finally {
        await app.close();
        await fs.rm(workdir, { recursive: true, force: true });
      }
    });
  });

  describe('POST /api/sessions/:id/sources', () => {
    it('adds a url source and returns it in the list', async () => {
      const { app } = await createRouteTestHarness(registerSourceRoutes);
      const post = await app.inject({
        method: 'POST',
        url: `/api/sessions/${SESSION_ID}/sources`,
        payload: { type: 'url', title: 'MDN Docs', url: 'https://developer.mozilla.org' },
      });
      expect(post.statusCode).toBe(200);
      const added = JSON.parse(post.body);
      expect(added.success).toBe(true);
      expect(added.data.source.id).toBeTruthy();
      expect(added.data.source.title).toBe('MDN Docs');

      // Verify it shows up in GET
      const get = await app.inject({ method: 'GET', url: `/api/sessions/${SESSION_ID}/sources` });
      const list = JSON.parse(get.body);
      expect(list.data.sources).toHaveLength(1);
    });

    it('adds a file source', async () => {
      const { app } = await createRouteTestHarness(registerSourceRoutes);
      const post = await app.inject({
        method: 'POST',
        url: `/api/sessions/${SESSION_ID}/sources`,
        payload: { type: 'file', title: 'design.md', relativePath: 'docs/design.md' },
      });
      expect(post.statusCode).toBe(200);
      const body = JSON.parse(post.body);
      expect(body.data.source.type).toBe('file');
      expect(body.data.source.relativePath).toBe('docs/design.md');
    });

    it('adds a highlight source', async () => {
      const { app } = await createRouteTestHarness(registerSourceRoutes);
      const post = await app.inject({
        method: 'POST',
        url: `/api/sessions/${SESSION_ID}/sources`,
        payload: { type: 'highlight', title: 'Key excerpt', content: 'This is the key point.' },
      });
      expect(post.statusCode).toBe(200);
      const body = JSON.parse(post.body);
      expect(body.data.source.content).toBe('This is the key point.');
    });

    it('returns 400 when title is missing', async () => {
      const { app } = await createRouteTestHarness(registerSourceRoutes);
      const res = await app.inject({
        method: 'POST',
        url: `/api/sessions/${SESSION_ID}/sources`,
        payload: { type: 'url', url: 'https://example.com' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('returns 400 for invalid type', async () => {
      const { app } = await createRouteTestHarness(registerSourceRoutes);
      const res = await app.inject({
        method: 'POST',
        url: `/api/sessions/${SESSION_ID}/sources`,
        payload: { type: 'video', title: 'Some video' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('returns 404 for unknown session', async () => {
      const { app } = await createRouteTestHarness(registerSourceRoutes);
      const res = await app.inject({
        method: 'POST',
        url: '/api/sessions/no-such-session/sources',
        payload: { type: 'url', title: 'T', url: 'https://example.com' },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('DELETE /api/sessions/:id/sources/:sourceId', () => {
    it('removes an existing source', async () => {
      const { app } = await createRouteTestHarness(registerSourceRoutes);
      // Add a source first
      const post = await app.inject({
        method: 'POST',
        url: `/api/sessions/${SESSION_ID}/sources`,
        payload: { type: 'url', title: 'Remove me', url: 'https://remove.io' },
      });
      const sourceId = JSON.parse(post.body).data.source.id;

      const del = await app.inject({
        method: 'DELETE',
        url: `/api/sessions/${SESSION_ID}/sources/${sourceId}`,
      });
      expect(del.statusCode).toBe(200);
      expect(JSON.parse(del.body).success).toBe(true);

      // Verify list is empty
      const get = await app.inject({ method: 'GET', url: `/api/sessions/${SESSION_ID}/sources` });
      expect(JSON.parse(get.body).data.sources).toHaveLength(0);
    });

    it('returns 200 even for unknown sourceId (idempotent)', async () => {
      const { app } = await createRouteTestHarness(registerSourceRoutes);
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/sessions/${SESSION_ID}/sources/nonexistent-id`,
      });
      expect(res.statusCode).toBe(200);
    });

    it('returns 404 for unknown session', async () => {
      const { app } = await createRouteTestHarness(registerSourceRoutes);
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/sessions/no-such/sources/some-id',
      });
      expect(res.statusCode).toBe(404);
    });
  });
});
