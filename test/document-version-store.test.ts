import { describe, it, expect, beforeEach } from 'vitest';
import { DocumentVersionStore } from '../src/document-version-store.js';

describe('DocumentVersionStore', () => {
  let store: DocumentVersionStore;
  const S = 'sess-1';
  const F = '/tmp/draft.md';

  beforeEach(() => {
    store = new DocumentVersionStore(5); // small ring for the eviction test
  });

  it('records a first version and returns it', () => {
    const v = store.record(S, F, '# v1', 100, 1);
    expect(v).not.toBeNull();
    expect(v?.content).toBe('# v1');
    expect(store.list(S, F)).toHaveLength(1);
  });

  it('does not record an unchanged document (same content)', () => {
    store.record(S, F, '# v1', 100, 1);
    const again = store.record(S, F, '# v1', 100, 2); // mtime moved but content identical
    expect(again).toBeNull();
    expect(store.list(S, F)).toHaveLength(1);
  });

  it('records a new version when content changes', () => {
    store.record(S, F, '# v1', 100, 1);
    const v2 = store.record(S, F, '# v2 changed', 200, 2);
    expect(v2).not.toBeNull();
    expect(store.list(S, F)).toHaveLength(2);
    // ids are unique and ordered
    const versions = store.list(S, F);
    expect(versions[0].id).not.toBe(versions[1].id);
  });

  it('list returns metadata without content; get returns content', () => {
    store.record(S, F, 'hello', 1, 5); // mtimeMs=1, size=5
    const meta = store.list(S, F)[0];
    expect(meta).not.toHaveProperty('content');
    expect(meta.size).toBe(5);
    const full = store.get(S, F, meta.id);
    expect(full?.content).toBe('hello');
  });

  it('bounds the ring to maxVersions, evicting oldest', () => {
    for (let i = 1; i <= 8; i++) store.record(S, F, `content ${i}`, i, i);
    const versions = store.list(S, F);
    expect(versions).toHaveLength(5); // capped at 5
    // oldest surviving is "content 4" (1..3 evicted)
    expect(store.get(S, F, versions[0].id)?.content).toBe('content 4');
    expect(store.get(S, F, versions[versions.length - 1].id)?.content).toBe('content 8');
  });

  it('keys versions per session+path independently', () => {
    store.record(S, F, 'a', 1, 1);
    store.record(S, '/tmp/other.md', 'b', 1, 1);
    store.record('sess-2', F, 'c', 1, 1);
    expect(store.list(S, F)).toHaveLength(1);
    expect(store.list(S, '/tmp/other.md')).toHaveLength(1);
    expect(store.list('sess-2', F)).toHaveLength(1);
  });

  it('clearSession drops all of a session’s document histories', () => {
    store.record(S, F, 'a', 1, 1);
    store.record(S, '/tmp/other.md', 'b', 1, 1);
    store.clearSession(S);
    expect(store.list(S, F)).toHaveLength(0);
    expect(store.list(S, '/tmp/other.md')).toHaveLength(0);
  });

  it('latest() returns the most recent version', () => {
    store.record(S, F, 'a', 1, 1);
    store.record(S, F, 'b', 2, 2);
    expect(store.latest(S, F)?.content).toBe('b');
  });
});
