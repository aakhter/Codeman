/**
 * TDD unit tests for COD-65 Session source store methods.
 * Tests run against the real Session class — no MockSession needed here.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { SessionSource } from '../src/types/sources.js';

// We only need to test the source-specific methods, so we import the real
// Session class but construct a minimal instance via a lightweight factory.
import { Session } from '../src/session.js';

function makeSource(
  overrides: Partial<SessionSource> & { id: string; type: SessionSource['type']; title: string }
): SessionSource {
  return {
    sessionId: 'test-session',
    addedAt: Date.now(),
    ...overrides,
  };
}

// Minimal session constructor params (mimicking existing tests).
let session: Session;
beforeEach(() => {
  session = new Session({
    id: 'test-session',
    workingDir: '/tmp',
    mode: 'claude',
    name: 'Test Session',
  } as never);
});

describe('Session#sources', () => {
  it('starts empty', () => {
    expect(session.sources).toEqual([]);
  });

  it('addSource adds a source', () => {
    const src = makeSource({ id: 'src1', type: 'url', title: 'MDN', url: 'https://mdn.io' });
    session.addSource(src);
    expect(session.sources).toHaveLength(1);
    expect(session.sources[0].id).toBe('src1');
  });

  it('addSource with same id replaces the existing entry', () => {
    session.addSource(makeSource({ id: 'src1', type: 'url', title: 'Old', url: 'https://old.io' }));
    session.addSource(makeSource({ id: 'src1', type: 'url', title: 'New', url: 'https://new.io' }));
    expect(session.sources).toHaveLength(1);
    expect(session.sources[0].title).toBe('New');
  });

  it('addSource preserves order (newest last)', () => {
    session.addSource(makeSource({ id: 's1', type: 'url', title: 'A', url: 'https://a.io' }));
    session.addSource(makeSource({ id: 's2', type: 'url', title: 'B', url: 'https://b.io' }));
    expect(session.sources.map((s) => s.id)).toEqual(['s1', 's2']);
  });

  it('removeSource removes by id', () => {
    session.addSource(makeSource({ id: 's1', type: 'url', title: 'A', url: 'https://a.io' }));
    session.addSource(makeSource({ id: 's2', type: 'url', title: 'B', url: 'https://b.io' }));
    session.removeSource('s1');
    expect(session.sources).toHaveLength(1);
    expect(session.sources[0].id).toBe('s2');
  });

  it('removeSource is idempotent for unknown id', () => {
    session.addSource(makeSource({ id: 's1', type: 'url', title: 'A', url: 'https://a.io' }));
    session.removeSource('nonexistent');
    expect(session.sources).toHaveLength(1);
  });

  it('toState includes sources when non-empty', () => {
    session.addSource(makeSource({ id: 's1', type: 'file', title: 'doc.md', relativePath: 'doc.md' }));
    const state = session.toState();
    expect(state.sources).toHaveLength(1);
    expect(state.sources![0].id).toBe('s1');
  });

  it('toState omits sources when empty', () => {
    const state = session.toState();
    expect(state.sources).toBeUndefined();
  });

  it('restoreSources repopulates from persisted data', () => {
    const data: SessionSource[] = [
      makeSource({ id: 'r1', type: 'url', title: 'R1', url: 'https://r1.io' }),
      makeSource({ id: 'r2', type: 'highlight', title: 'R2', content: 'quoted text' }),
    ];
    session.restoreSources(data);
    expect(session.sources).toHaveLength(2);
    expect(session.sources.map((s) => s.id)).toContain('r1');
  });

  it('restoreSources is tolerant of undefined', () => {
    session.restoreSources(undefined);
    expect(session.sources).toEqual([]);
  });

  it('getSourcesForPersist returns undefined when empty', () => {
    expect(session.getSourcesForPersist()).toBeUndefined();
  });

  it('getSourcesForPersist returns a copy when non-empty', () => {
    session.addSource(makeSource({ id: 's1', type: 'url', title: 'T', url: 'https://t.io' }));
    const forPersist = session.getSourcesForPersist();
    expect(forPersist).toHaveLength(1);
    // Must be a copy — mutating it must not affect the session's live list
    forPersist![0].title = 'mutated';
    expect(session.sources[0].title).toBe('T');
  });
});
