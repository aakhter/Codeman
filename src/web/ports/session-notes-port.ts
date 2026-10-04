/** @fileoverview Trusted owner-private notebook capabilities exposed to HTTP routes. */
import type { SessionNotesService, SessionNotesSource } from '../../session-notes-service.js';
import type { NotesDelivery } from '../notes-input.js';
import type { CaseInfo } from '../../types/api.js';
export interface SessionNotesPort {
  readonly sessionNotes: SessionNotesService;
  /** Exact owner match, including admins; may consult owner-verified persisted sessions. */
  getNotesSource(id: string, owner?: string): Promise<(SessionNotesSource & { owner?: string }) | null>;
  listNotesCases(owner?: string): Promise<CaseInfo[]>;
  listNotesDestinations?(owner?: string): Promise<{ id: string; name: string; mode?: string }[]>;
  /** Rechecks exact ownership and live eligibility at dispatch, never starts/resumes a session. */
  sendNotesInput?(id: string, owner: string | undefined, text: string): Promise<NotesDelivery>;
}
