import type { Session } from '../../session.js';
import type { SessionActivityProjection } from '../../types/session.js';

/** Minimal server-owned activity lifecycle exposed to routes and session listeners. */
export interface AgentActivityControllerPort {
  attachSession(session: Session): void;
  detachSession(session: Session): void;
  identityChanged(session: Session): void;
  terminalActivity(session: Session): void;
  sessionExited(session: Session): void;
  setTrackingEnabled(enabled: boolean): void;
  project(session: Session): SessionActivityProjection;
}

export interface AgentActivityPort {
  readonly agentActivity: AgentActivityControllerPort;
}
