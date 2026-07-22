/**
 * @fileoverview Library index types for COD-63 knowledge-base feature.
 *
 * LibraryDocument is a cross-session record derived from session attachment histories,
 * covering document-type files (pdf, document, presentation, markdown, text).
 * Tags and folders are V1 placeholders (always empty until a tag-management API is added).
 */

import type { AttachmentDetectedType } from './tools.js';

/** Attachment types that qualify as knowledge-base documents (excludes 'image'). */
export type LibraryDocumentType = Exclude<AttachmentDetectedType, 'image'>;

/** A single document entry in the cross-session library index. */
export interface LibraryDocument {
  /** Stable identity — matches the source SessionAttachmentHistoryItem id. */
  id: string;
  /** Session that most recently observed this document. */
  sessionId: string;
  /** Display name of the session. */
  sessionName: string;
  /** Filename including extension. */
  fileName: string;
  /** Lowercase extension without dot (e.g. 'pdf', 'md'). */
  extension: string;
  /** Viewer category. */
  attachmentType: LibraryDocumentType;
  /** Workspace-relative path when available (detected session files only). */
  relativePath?: string;
  /** File modification time in ms. */
  mtimeMs: number;
  /** Timestamp when the attachment was first added to the session. */
  addedAt: number;
  /** User-applied tags — empty until a tag-management API is added (V2). */
  tags: string[];
  /** User-applied folder — undefined until folder API is added (V2). */
  folder?: string;
}

/** Response envelope data for GET /api/library. */
export interface LibraryQueryResult {
  documents: LibraryDocument[];
  total: number;
}
