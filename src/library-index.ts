/**
 * @fileoverview Cross-session knowledge-base library index for COD-63.
 *
 * Provides two pure functions:
 *
 *   harvestDocuments(sessions)   — walks all session attachment histories, filters
 *                                  to document types, deduplicates by id (keeping the
 *                                  most-recent mtime), and returns sorted by mtime desc.
 *
 *   queryDocuments(docs, q, tag, limit) — text-searches fileName + relativePath and
 *                                         optionally filters by tag.
 *
 * Both functions are IO-free. The route handler calls them fresh per request so there
 * is no stale-index problem — session attachment histories are bounded (<= 100 items
 * per session, <= 50 sessions = trivially fast).
 *
 * Tags and folder fields are V1 placeholders (always empty). A tag-management API
 * will populate them in a future cycle.
 */

import type { LibraryDocument } from './types/library.js';

/** Attachment types that count as documents in the knowledge-base library. */
const DOCUMENT_TYPES = new Set(['pdf', 'document', 'presentation', 'markdown', 'text']);

/** Minimal session duck-type used by harvestDocuments. */
interface SessionLike {
  id: string;
  name: string;
  attachmentHistory: ReadonlyArray<{
    id: string;
    sessionId: string;
    fileName: string;
    extension: string;
    attachmentType: string;
    size: number;
    mtimeMs: number;
    timestamp: number;
    source: string;
    relativePath?: string;
  }>;
}

/**
 * Walk all sessions' attachment histories and build a deduplicated, sorted
 * array of knowledge-base documents.
 *
 * Deduplication key: history item `id`. When the same id appears in multiple
 * sessions (e.g. a file re-attached later), the entry with the higher `mtimeMs`
 * wins.
 */
export function harvestDocuments(sessions: ReadonlyMap<string, SessionLike>): LibraryDocument[] {
  const seen = new Map<string, LibraryDocument>();

  for (const session of sessions.values()) {
    const sessionName = session.name;
    for (const item of session.attachmentHistory) {
      if (!DOCUMENT_TYPES.has(item.attachmentType)) continue;

      const existing = seen.get(item.id);
      if (existing && existing.mtimeMs >= item.mtimeMs) continue;

      seen.set(item.id, {
        id: item.id,
        sessionId: item.sessionId,
        sessionName,
        fileName: item.fileName,
        extension: item.extension,
        attachmentType: item.attachmentType as LibraryDocument['attachmentType'],
        relativePath: item.relativePath,
        mtimeMs: item.mtimeMs,
        addedAt: item.timestamp,
        tags: [],
      });
    }
  }

  return [...seen.values()].sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * Filter and search a set of library documents.
 *
 * @param documents - Pre-harvested document array (from harvestDocuments).
 * @param q         - Free-text query; matches fileName and relativePath (case-insensitive).
 *                    Empty string returns all.
 * @param tag       - Exact tag match (case-insensitive). Undefined = no tag filter.
 * @param limit     - Maximum number of results to return. Undefined = no cap.
 */
export function queryDocuments(
  documents: LibraryDocument[],
  q: string,
  tag?: string,
  limit?: number
): LibraryDocument[] {
  const lq = q.toLowerCase().trim();
  const lt = tag?.toLowerCase();

  let results = documents;

  if (lt) {
    results = results.filter((d) => d.tags.some((t) => t.toLowerCase() === lt));
  }

  if (lq) {
    results = results.filter(
      (d) => d.fileName.toLowerCase().includes(lq) || (d.relativePath ?? '').toLowerCase().includes(lq)
    );
  }

  if (limit != null && limit > 0) {
    results = results.slice(0, limit);
  }

  return results;
}
