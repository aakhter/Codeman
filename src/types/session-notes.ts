/** @fileoverview Persistent session notebook metadata, content, and repair entry contracts. */

export interface SessionNoteMetadata {
  version: 1;
  id: string;
  ownerKey: string;
  projectId: string;
  sessionId: string;
  sessionAliases: string[];
  sessionTitle: string;
  title: string;
  workingDir: string;
  executionLocation: string;
  createdAt: number;
  updatedAt: number;
}

export interface SessionNote {
  metadata: SessionNoteMetadata;
  markdown: string;
  /** Canonical byte SHA-256, draft-<binding digest> for durable drafts, or empty for a store-only transient. */
  revision: string;
}

export interface SessionNoteEntry {
  id: string;
  projectId: string;
  note?: SessionNote;
  repairable: boolean;
  /** Filesystem mtime reflects external edits even when frontmatter timestamps do not. */
  lastModified?: number;
  unfinishedCount?: number;
  checklist?: Array<{ line: number; checked: boolean; text: string }>;
  sessionAliases?: string[];
  raw?: string;
  revision?: string;
  error?: string;
  conflict?: string;
}

export type SessionNoteCreate = Omit<SessionNoteMetadata, 'version' | 'ownerKey' | 'createdAt' | 'updatedAt' | 'id'> & {
  id?: string;
};

/** Preserved recovery artifacts needing manual repair; notebook operations remain available. */
export interface SessionNotesRecoveryIssue {
  path: string;
  raw: string;
  revision: string;
  error: string;
}
