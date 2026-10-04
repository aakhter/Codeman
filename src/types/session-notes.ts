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
  /** SHA-256 of all persisted bytes; empty for a transient draft. */
  revision: string;
}

export interface SessionNoteEntry {
  id: string;
  projectId: string;
  note?: SessionNote;
  repairable: boolean;
  raw?: string;
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
