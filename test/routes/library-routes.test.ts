/**
 * TDD route tests for COD-63 GET /api/library.
 */
import { describe, it, expect } from 'vitest';
import { createRouteTestHarness } from './_route-test-utils.js';
import { registerLibraryRoutes } from '../../src/web/routes/library-routes.js';
import type { SessionAttachmentHistoryItem } from '../../src/types/session.js';
import type { MockSession } from '../mocks/mock-session.js';

function makeHistoryItem(
  overrides: Partial<SessionAttachmentHistoryItem> & { id: string; fileName: string }
): SessionAttachmentHistoryItem {
  return {
    sessionId: 'test-session-1',
    extension: 'md',
    attachmentType: 'markdown',
    size: 512,
    mtimeMs: Date.now(),
    timestamp: Date.now(),
    source: 'detected',
    ...overrides,
  };
}

function seedHistory(session: MockSession, items: SessionAttachmentHistoryItem[]) {
  for (const item of items) {
    session.upsertAttachmentHistory(item);
  }
}

describe('GET /api/library', () => {
  it('returns an empty document list when session has no attachment history', async () => {
    const { app } = await createRouteTestHarness(registerLibraryRoutes);

    const res = await app.inject({ method: 'GET', url: '/api/library' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.documents).toEqual([]);
  });

  it('returns documents from session attachment history', async () => {
    const { app, ctx } = await createRouteTestHarness(registerLibraryRoutes);
    seedHistory(ctx._session, [
      makeHistoryItem({ id: 'lib1', fileName: 'design.md', extension: 'md', attachmentType: 'markdown' }),
      makeHistoryItem({ id: 'lib2', fileName: 'report.pdf', extension: 'pdf', attachmentType: 'pdf' }),
    ]);

    const res = await app.inject({ method: 'GET', url: '/api/library' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.documents).toHaveLength(2);
    expect(body.data.documents.map((d: { fileName: string }) => d.fileName)).toContain('design.md');
  });

  it('filters by ?q= query string', async () => {
    const { app, ctx } = await createRouteTestHarness(registerLibraryRoutes);
    seedHistory(ctx._session, [
      makeHistoryItem({ id: 'f1', fileName: 'alpha.md', extension: 'md', attachmentType: 'markdown' }),
      makeHistoryItem({ id: 'f2', fileName: 'beta.pdf', extension: 'pdf', attachmentType: 'pdf' }),
    ]);

    const res = await app.inject({ method: 'GET', url: '/api/library?q=alpha' });
    const body = JSON.parse(res.body);
    expect(body.data.documents).toHaveLength(1);
    expect(body.data.documents[0].fileName).toBe('alpha.md');
  });

  it('excludes image-type items', async () => {
    const { app, ctx } = await createRouteTestHarness(registerLibraryRoutes);
    seedHistory(ctx._session, [
      makeHistoryItem({ id: 'i1', fileName: 'photo.png', extension: 'png', attachmentType: 'image' as never }),
      makeHistoryItem({ id: 'i2', fileName: 'doc.txt', extension: 'txt', attachmentType: 'text' }),
    ]);

    const res = await app.inject({ method: 'GET', url: '/api/library' });
    const body = JSON.parse(res.body);
    expect(body.data.documents).toHaveLength(1);
    expect(body.data.documents[0].fileName).toBe('doc.txt');
  });

  it('respects ?limit= parameter', async () => {
    const { app, ctx } = await createRouteTestHarness(registerLibraryRoutes);
    seedHistory(ctx._session, [
      makeHistoryItem({ id: 'l1', fileName: 'a.md', extension: 'md', attachmentType: 'markdown', mtimeMs: 3000 }),
      makeHistoryItem({ id: 'l2', fileName: 'b.md', extension: 'md', attachmentType: 'markdown', mtimeMs: 2000 }),
      makeHistoryItem({ id: 'l3', fileName: 'c.md', extension: 'md', attachmentType: 'markdown', mtimeMs: 1000 }),
    ]);

    const res = await app.inject({ method: 'GET', url: '/api/library?limit=2' });
    const body = JSON.parse(res.body);
    expect(body.data.documents).toHaveLength(2);
  });

  it('returns 400 on invalid limit', async () => {
    const { app } = await createRouteTestHarness(registerLibraryRoutes);
    const res = await app.inject({ method: 'GET', url: '/api/library?limit=notanumber' });
    expect(res.statusCode).toBe(400);
  });

  it('data envelope has documents and total fields', async () => {
    const { app, ctx } = await createRouteTestHarness(registerLibraryRoutes);
    seedHistory(ctx._session, [
      makeHistoryItem({ id: 't1', fileName: 'x.md', extension: 'md', attachmentType: 'markdown' }),
    ]);

    const res = await app.inject({ method: 'GET', url: '/api/library' });
    const body = JSON.parse(res.body);
    expect(body.data).toHaveProperty('documents');
    expect(body.data).toHaveProperty('total');
    expect(body.data.total).toBe(1);
  });
});
