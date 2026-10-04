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

  it('records binary versions (raw bytes) and dedups by bytes (COD-66)', () => {
    const a = Buffer.from('docx-bytes-A');
    const v1 = store.record(S, F, 'extracted text A', 1, a.length, a);
    expect(v1?.raw?.equals(a)).toBe(true);
    // same bytes -> no new version even if the extracted text string differs
    const again = store.record(S, F, 'different extracted text', 2, a.length, a);
    expect(again).toBeNull();
    // different bytes -> new version
    const b = Buffer.from('docx-bytes-B-longer');
    const v2 = store.record(S, F, 'extracted text B', 3, b.length, b);
    expect(v2).not.toBeNull();
    expect(store.list(S, F)).toHaveLength(2);
  });

  it('list omits raw bytes; get returns them for rollback (COD-66)', () => {
    const a = Buffer.from('bytes');
    store.record(S, F, 'text', 1, a.length, a);
    const meta = store.list(S, F)[0];
    expect(meta).not.toHaveProperty('raw');
    expect(meta).not.toHaveProperty('content');
    expect(store.get(S, F, meta.id)?.raw?.equals(a)).toBe(true);
  });

  it('keeps the 50-version count cap by default', () => {
    const big = new DocumentVersionStore();
    for (let i = 1; i <= 60; i++) big.record(S, F, `c${i}`, i, i);
    expect(big.list(S, F)).toHaveLength(50);
  });
});

// COD-457: bytes, not just version counts, bound the store.
describe('DocumentVersionStore byte caps (COD-457)', () => {
  const S = 'sess-1';
  const F = '/tmp/draft.md';
  const kb = (n: number, ch = 'a') => ch.repeat(n * 1024);

  it('counts string bytes as UTF-8 and raw Buffer bytes', () => {
    const store = new DocumentVersionStore(50, 1024 * 1024, 4 * 1024 * 1024);
    store.record(S, F, 'é'.repeat(100), 1, 200); // 2 bytes per char
    expect(store.totalBytes).toBe(200);
    const raw = Buffer.alloc(1000);
    store.record(S, '/tmp/a.docx', 'xyz', 1, 1000, raw);
    expect(store.totalBytes).toBe(200 + 1000 + 3);
  });

  it('evicts oldest versions of a file until it is under the per-file byte cap', () => {
    const store = new DocumentVersionStore(50, 10 * 1024, 1024 * 1024);
    for (let i = 0; i < 5; i++) store.record(S, F, kb(4, String.fromCharCode(97 + i)), i, 4096);
    // 5 x 4KB = 20KB > 10KB: only the newest two (8KB) survive.
    const versions = store.list(S, F);
    expect(versions).toHaveLength(2);
    expect(store.get(S, F, versions[1].id)?.content).toBe(kb(4, 'e'));
    expect(store.totalBytes).toBe(8 * 1024);
  });

  it('skips recording a single version larger than the per-file cap', () => {
    const store = new DocumentVersionStore(50, 10 * 1024, 1024 * 1024);
    store.record(S, F, 'small', 1, 5);
    expect(store.record(S, F, kb(11), 2, 11 * 1024)).toBeNull();
    // The existing history is untouched rather than flushed out by the giant.
    expect(store.list(S, F)).toHaveLength(1);
    expect(store.latest(S, F)?.content).toBe('small');
    expect(store.totalBytes).toBe(5);
  });

  it('skips an oversized binary version by counting its raw bytes', () => {
    const store = new DocumentVersionStore(50, 10 * 1024, 1024 * 1024);
    expect(store.record(S, '/tmp/a.docx', 'tiny text', 1, 11 * 1024, Buffer.alloc(11 * 1024))).toBeNull();
    expect(store.list(S, '/tmp/a.docx')).toHaveLength(0);
  });

  it('evicts least-recently-touched file histories past the global byte cap', () => {
    const store = new DocumentVersionStore(50, 8 * 1024, 16 * 1024);
    store.record('s1', '/a.md', kb(6), 1, 6144);
    store.record('s2', '/b.md', kb(6), 1, 6144);
    // Touch /a.md so /b.md becomes the least-recently-touched history.
    store.list('s1', '/a.md');
    store.record('s3', '/c.md', kb(6), 1, 6144); // 18KB > 16KB
    expect(store.list('s2', '/b.md')).toHaveLength(0);
    expect(store.list('s1', '/a.md')).toHaveLength(1);
    expect(store.list('s3', '/c.md')).toHaveLength(1);
    expect(store.totalBytes).toBe(12 * 1024);
  });

  it('keeps version ids monotonic after a history is evicted globally', () => {
    const store = new DocumentVersionStore(50, 8 * 1024, 8 * 1024);
    store.record('s1', '/a.md', 'one', 1, 3);
    store.record('s1', '/a.md', 'two', 2, 3);
    store.record('s2', '/b.md', kb(8), 1, 8192); // evicts /a.md entirely
    expect(store.list('s1', '/a.md')).toHaveLength(0);
    const v = store.record('s1', '/a.md', 'three', 3, 5);
    expect(v?.id).toBe('v3'); // never re-issues v1, which a client may still hold
  });

  it('clearSession releases the session bytes', () => {
    const store = new DocumentVersionStore();
    store.record(S, F, 'abc', 1, 3);
    store.record('other', F, 'de', 1, 2);
    store.clearSession(S);
    expect(store.totalBytes).toBe(2);
    expect(store.hasSession(S)).toBe(false);
    expect(store.hasSession('other')).toBe(true);
  });
});
