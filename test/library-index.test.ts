/**
 * TDD tests for COD-63 library index — harvestDocuments + queryDocuments.
 * Written before implementation; all tests start failing.
 */
import { describe, it, expect } from 'vitest';
import type { SessionAttachmentHistoryItem } from '../src/types/session.js';
import { harvestDocuments, queryDocuments } from '../src/library-index.js';

// --- minimal session stub ---------------------------------------------------

function makeHistoryItem(
  overrides: Partial<SessionAttachmentHistoryItem> & { id: string; fileName: string }
): SessionAttachmentHistoryItem {
  return {
    sessionId: 'sess-1',
    extension: 'md',
    attachmentType: 'markdown',
    size: 1024,
    mtimeMs: 1000,
    timestamp: 2000,
    source: 'detected',
    ...overrides,
  };
}

function makeSession(id: string, name: string, history: SessionAttachmentHistoryItem[]) {
  return {
    id,
    name,
    attachmentHistory: history,
  };
}

function makeSessions(entries: Array<{ id: string; name: string; history: SessionAttachmentHistoryItem[] }>) {
  const map = new Map<string, ReturnType<typeof makeSession>>();
  for (const e of entries) {
    map.set(e.id, makeSession(e.id, e.name, e.history));
  }
  return map;
}

// ---------------------------------------------------------------------------

describe('harvestDocuments', () => {
  it('returns an empty array when no sessions', () => {
    const docs = harvestDocuments(new Map());
    expect(docs).toEqual([]);
  });

  it('returns document-type attachments from a session', () => {
    const history = [
      makeHistoryItem({ id: 'a1', fileName: 'report.pdf', extension: 'pdf', attachmentType: 'pdf' }),
      makeHistoryItem({ id: 'a2', fileName: 'notes.md', extension: 'md', attachmentType: 'markdown' }),
    ];
    const sessions = makeSessions([{ id: 'sess-1', name: 'Session One', history }]);

    const docs = harvestDocuments(sessions as never);
    expect(docs).toHaveLength(2);
    expect(docs.map((d) => d.fileName)).toContain('report.pdf');
    expect(docs.map((d) => d.fileName)).toContain('notes.md');
  });

  it('excludes image-type attachments', () => {
    const history = [
      makeHistoryItem({ id: 'img1', fileName: 'photo.png', extension: 'png', attachmentType: 'image' as never }),
      makeHistoryItem({ id: 'doc1', fileName: 'brief.docx', extension: 'docx', attachmentType: 'document' }),
    ];
    const sessions = makeSessions([{ id: 'sess-1', name: 'S', history }]);
    const docs = harvestDocuments(sessions as never);
    expect(docs).toHaveLength(1);
    expect(docs[0].fileName).toBe('brief.docx');
  });

  it('deduplicates by item id, keeping the entry with the latest mtimeMs', () => {
    const older = makeHistoryItem({
      id: 'dup-1',
      fileName: 'spec.md',
      extension: 'md',
      attachmentType: 'markdown',
      sessionId: 'sess-1',
      mtimeMs: 1000,
    });
    const newer = makeHistoryItem({
      id: 'dup-1',
      fileName: 'spec.md',
      extension: 'md',
      attachmentType: 'markdown',
      sessionId: 'sess-2',
      mtimeMs: 5000,
    });
    const sessions = makeSessions([
      { id: 'sess-1', name: 'A', history: [older] },
      { id: 'sess-2', name: 'B', history: [newer] },
    ]);

    const docs = harvestDocuments(sessions as never);
    expect(docs).toHaveLength(1);
    expect(docs[0].mtimeMs).toBe(5000);
    expect(docs[0].sessionId).toBe('sess-2');
  });

  it('sorts results by mtimeMs descending', () => {
    const history = [
      makeHistoryItem({ id: 'a1', fileName: 'old.txt', extension: 'txt', attachmentType: 'text', mtimeMs: 100 }),
      makeHistoryItem({ id: 'a2', fileName: 'new.txt', extension: 'txt', attachmentType: 'text', mtimeMs: 900 }),
      makeHistoryItem({ id: 'a3', fileName: 'mid.txt', extension: 'txt', attachmentType: 'text', mtimeMs: 500 }),
    ];
    const sessions = makeSessions([{ id: 'sess-1', name: 'S', history }]);
    const docs = harvestDocuments(sessions as never);
    expect(docs.map((d) => d.mtimeMs)).toEqual([900, 500, 100]);
  });

  it('includes sessionName from the session', () => {
    const history = [makeHistoryItem({ id: 'x1', fileName: 'f.md', extension: 'md', attachmentType: 'markdown' })];
    const sessions = makeSessions([{ id: 'sess-1', name: 'My Project', history }]);
    const docs = harvestDocuments(sessions as never);
    expect(docs[0].sessionName).toBe('My Project');
  });

  it('includes relativePath when present on the history item', () => {
    const item = makeHistoryItem({
      id: 'r1',
      fileName: 'readme.md',
      extension: 'md',
      attachmentType: 'markdown',
      relativePath: 'docs/readme.md',
    });
    const sessions = makeSessions([{ id: 's1', name: 'S', history: [item] }]);
    const docs = harvestDocuments(sessions as never);
    expect(docs[0].relativePath).toBe('docs/readme.md');
  });

  it('initialises tags to empty array', () => {
    const history = [makeHistoryItem({ id: 'q1', fileName: 'q.pdf', extension: 'pdf', attachmentType: 'pdf' })];
    const sessions = makeSessions([{ id: 's1', name: 'S', history }]);
    const docs = harvestDocuments(sessions as never);
    expect(docs[0].tags).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe('queryDocuments', () => {
  const base = [
    {
      id: 'd1',
      sessionId: 's1',
      sessionName: 'Proj A',
      fileName: 'alpha-report.pdf',
      extension: 'pdf',
      attachmentType: 'pdf' as const,
      mtimeMs: 1000,
      addedAt: 2000,
      tags: ['finance'],
      relativePath: undefined,
    },
    {
      id: 'd2',
      sessionId: 's1',
      sessionName: 'Proj A',
      fileName: 'beta-notes.md',
      extension: 'md',
      attachmentType: 'markdown' as const,
      mtimeMs: 800,
      addedAt: 1600,
      tags: ['notes'],
      relativePath: 'docs/beta-notes.md',
    },
    {
      id: 'd3',
      sessionId: 's2',
      sessionName: 'Proj B',
      fileName: 'gamma.docx',
      extension: 'docx',
      attachmentType: 'document' as const,
      mtimeMs: 600,
      addedAt: 1200,
      tags: [],
      relativePath: undefined,
    },
  ];

  it('returns all documents when query is empty', () => {
    const results = queryDocuments(base, '');
    expect(results).toHaveLength(3);
  });

  it('filters by filename text (case-insensitive)', () => {
    const results = queryDocuments(base, 'alpha');
    expect(results).toHaveLength(1);
    expect(results[0].fileName).toBe('alpha-report.pdf');
  });

  it('filters by relativePath text', () => {
    const results = queryDocuments(base, 'docs/beta');
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('d2');
  });

  it('filters by tag (exact match)', () => {
    const results = queryDocuments(base, '', 'finance');
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('d1');
  });

  it('combines text query and tag filter', () => {
    // 'notes' tag AND 'beta' in fileName
    const results = queryDocuments(base, 'beta', 'notes');
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('d2');
  });

  it('returns empty array when nothing matches', () => {
    const results = queryDocuments(base, 'zzz-nomatch');
    expect(results).toEqual([]);
  });

  it('respects limit parameter', () => {
    const results = queryDocuments(base, '', undefined, 2);
    expect(results).toHaveLength(2);
  });
});
