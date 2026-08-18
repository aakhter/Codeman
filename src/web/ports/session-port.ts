/**
 * @fileoverview Session port — capabilities for session lifecycle management.
 * Route modules that manage sessions depend on this port.
 */

import type { Session } from '../../session.js';
import type { TabLayout } from '../../tab-layout.js';

export interface SessionCreationOptions {
  tabGroupId?: string;
}

export interface SessionPort {
  readonly sessions: ReadonlyMap<string, Session>;
  addSession(session: Session, options?: SessionCreationOptions): Promise<TabLayout>;
  cleanupSession(sessionId: string, killMux?: boolean, reason?: string): Promise<void>;
  setupSessionListeners(session: Session): Promise<void>;
  persistSessionState(session: Session): void;
  persistSessionStateNow(session: Session): void;
  getSessionStateWithRespawn(session: Session): unknown;
}
