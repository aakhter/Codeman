/** @fileoverview Trusted owner-private notebook capabilities exposed to HTTP routes. */
import type { SessionNotesService, SessionNotesSource } from '../../session-notes-service.js';
import type { CaseInfo } from '../../types/api.js';
export interface SessionNotesPort {
  readonly sessionNotes: SessionNotesService;
  /** Exact owner match, including admins; may consult owner-verified persisted sessions. */
  getNotesSource(id: string, owner?: string): Promise<(SessionNotesSource & { owner?: string }) | null>;
  listNotesCases(owner?: string): Promise<CaseInfo[]>;
}
