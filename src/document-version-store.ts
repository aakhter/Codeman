/**
 * @fileoverview In-memory revision history for previewed documents (COD-59).
 *
 * A bounded ring of content snapshots per (session, file). Versions are captured
 * lazily off the live-preview poll (COD-58) — when a previewed text/markdown file
 * changes on disk, the current content is recorded — so the authoring loop
 * (open preview, watch the agent revise) accumulates a diffable, rollback-able
 * history without a backend file watcher.
 *
 * In-memory only: history is per server run and is dropped on restart or when
 * the session is cleaned up (`_doCleanupSession()` in server.ts calls
 * `clearSession()`, COD-457). Persisting snapshots is a deliberate follow-up
 * (full document bodies would bloat state.json).
 *
 * Bounds (COD-457): at most `maxVersions` per (session, file), at most
 * `maxFileBytes` per (session, file) (oldest versions evicted; a single version
 * over the cap is not recorded), and at most `maxTotalBytes` overall (the
 * least-recently-touched (session, file) histories are dropped whole). Bytes
 * are UTF-8 content plus raw Buffer bytes. Only consecutive duplicates are
 * de-duplicated (`record()` compares against the latest version).
 */

import { DOCUMENT_VERSION_MAX_FILE_BYTES, DOCUMENT_VERSION_MAX_TOTAL_BYTES } from './config/buffer-limits.js';

export interface DocumentVersion {
  /** Stable id, unique within a (session, file). */
  id: string;
  /** Monotonic sequence number within a (session, file). */
  seq: number;
  /** When this snapshot was captured (ms epoch). */
  timestamp: number;
  /** Byte length of the snapshot content. */
  size: number;
  /** File mtime (ms) at capture, if known. */
  mtimeMs: number;
  /** Diffable text content (for binary docs, this is the extracted text). */
  content: string;
  /** Raw file bytes for byte-perfect rollback of binary documents (e.g. .docx). */
  raw?: Buffer;
}

/** Version metadata without the (potentially large) content body. */
export type DocumentVersionMeta = Omit<DocumentVersion, 'content'>;

const DEFAULT_MAX_VERSIONS = 50;

/** Bytes a version pins in memory: its diff text plus any raw file bytes. */
function versionBytes(content: string, raw?: Buffer): number {
  return Buffer.byteLength(content, 'utf8') + (raw ? raw.length : 0);
}

export class DocumentVersionStore {
  /** Insertion order doubles as recency: a touched key is moved to the end. */
  private byKey = new Map<string, DocumentVersion[]>();
  /** Survives a global eviction so a re-captured file never re-issues an old id. */
  private seqByKey = new Map<string, number>();
  private bytesByKey = new Map<string, number>();
  private _totalBytes = 0;
  private readonly maxFileBytes: number;

  constructor(
    private readonly maxVersions = DEFAULT_MAX_VERSIONS,
    maxFileBytes = DOCUMENT_VERSION_MAX_FILE_BYTES,
    private readonly maxTotalBytes = DOCUMENT_VERSION_MAX_TOTAL_BYTES
  ) {
    // A history larger than the global budget could never be kept anyway.
    this.maxFileBytes = Math.min(maxFileBytes, maxTotalBytes);
  }

  /** Total bytes currently held across every session and file. */
  get totalBytes(): number {
    return this._totalBytes;
  }

  /** Largest single version `record()` will accept, in bytes. */
  get maxVersionBytes(): number {
    return this.maxFileBytes;
  }

  /** True while any history is held for the session. */
  hasSession(sessionId: string): boolean {
    const prefix = `${sessionId}\0`;
    for (const key of this.byKey.keys()) if (key.startsWith(prefix)) return true;
    return false;
  }

  private key(sessionId: string, filePath: string): string {
    return `${sessionId}\0${filePath}`;
  }

  /** Mark a history most-recently-used (Map iteration order is the LRU order). */
  private touch(key: string): DocumentVersion[] | undefined {
    const versions = this.byKey.get(key);
    if (versions) {
      this.byKey.delete(key);
      this.byKey.set(key, versions);
    }
    return versions;
  }

  private dropKey(key: string): void {
    this._totalBytes -= this.bytesByKey.get(key) ?? 0;
    this.byKey.delete(key);
    this.bytesByKey.delete(key);
  }

  /**
   * Record a snapshot if the content differs from the latest version. Returns the
   * new version, or null when unchanged (so callers can avoid re-reading content
   * for an unchanged file).
   */
  record(
    sessionId: string,
    filePath: string,
    content: string,
    mtimeMs: number,
    size: number,
    raw?: Buffer
  ): DocumentVersion | null {
    const key = this.key(sessionId, filePath);
    const versions = this.touch(key) ?? [];
    const latest = versions[versions.length - 1];
    if (latest) {
      // Binary docs dedup by raw bytes (formatting-only edits still version);
      // text docs dedup by their text content.
      const unchanged = raw ? !!latest.raw && latest.raw.equals(raw) : latest.content === content;
      if (unchanged) return null;
    }
    const bytes = versionBytes(content, raw);
    // One version bigger than the whole per-file budget: skip it rather than
    // flush the file's existing history out to make room for it.
    if (bytes > this.maxFileBytes) return null;

    const seq = (this.seqByKey.get(key) ?? 0) + 1;
    this.seqByKey.set(key, seq);
    const version: DocumentVersion = {
      id: `v${seq}`,
      seq,
      timestamp: Date.now(),
      size,
      mtimeMs,
      content,
      raw,
    };
    versions.push(version);
    let fileBytes = (this.bytesByKey.get(key) ?? 0) + bytes;
    this._totalBytes += bytes;
    while (versions.length > this.maxVersions || fileBytes > this.maxFileBytes) {
      const evicted = versions.shift();
      if (!evicted) break;
      const freed = versionBytes(evicted.content, evicted.raw);
      fileBytes -= freed;
      this._totalBytes -= freed;
    }
    this.byKey.set(key, versions);
    this.bytesByKey.set(key, fileBytes);
    // Global budget: drop whole least-recently-touched histories, never this one.
    for (const other of this.byKey.keys()) {
      if (this._totalBytes <= this.maxTotalBytes) break;
      if (other !== key) this.dropKey(other);
    }
    return version;
  }

  /** Ascending list of version metadata (oldest first), without content. */
  list(sessionId: string, filePath: string): DocumentVersionMeta[] {
    const versions = this.touch(this.key(sessionId, filePath)) ?? [];
    return versions.map((v) => ({ id: v.id, seq: v.seq, timestamp: v.timestamp, size: v.size, mtimeMs: v.mtimeMs }));
  }

  get(sessionId: string, filePath: string, versionId: string): DocumentVersion | undefined {
    return this.touch(this.key(sessionId, filePath))?.find((v) => v.id === versionId);
  }

  latest(sessionId: string, filePath: string): DocumentVersion | undefined {
    const versions = this.touch(this.key(sessionId, filePath));
    return versions && versions.length ? versions[versions.length - 1] : undefined;
  }

  clearSession(sessionId: string): void {
    const prefix = `${sessionId}\0`;
    for (const key of this.byKey.keys()) {
      if (key.startsWith(prefix)) this.dropKey(key);
    }
    for (const key of this.seqByKey.keys()) {
      if (key.startsWith(prefix)) this.seqByKey.delete(key);
    }
  }
}

export const documentVersionStore = new DocumentVersionStore();
