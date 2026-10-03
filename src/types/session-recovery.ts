/**
 * @fileoverview Durable, sanitized records used to recover sessions after a host reboot.
 *
 * Recovery records intentionally remain separate from active SessionState entries. They
 * contain only the information needed to decide which recovery action is safe to offer.
 */

import type { SessionMode } from './session.js';

export type SessionRecoveryTransport = 'local' | 'remote' | 'docker';

export type SessionRecoveryStatus =
  | 'pending'
  | 'reattachable'
  | 'resumable'
  | 'manual_required'
  | 'unavailable'
  | 'recovered';

export type SessionRecoveryLaunch =
  | { kind: 'built-in' }
  | { kind: 'template'; templateId: string }
  | { kind: 'manual_required'; hint: string };

/** Durable locator only; credentials, commands and transport overrides stay in canonical config. */
export interface RecoveryRemoteTarget {
  hostId: string;
  owned?: boolean;
  remoteSessionName?: string;
}

/** Durable locator only; Docker daemon/command options stay in canonical config. */
export interface RecoveryDockerTarget {
  hostId: string;
  containerName: string;
}

/** Sanitized, durable evidence for one session that needs explicit recovery. */
export interface SessionRecoveryRecord {
  id: string;
  sourceSessionId: string;
  /** Codeman tab name, preserved before the session record is pruned. */
  name?: string;
  owner?: string;
  mode: SessionMode;
  workingDir: string;
  transport: SessionRecoveryTransport;
  remote?: RecoveryRemoteTarget;
  docker?: RecoveryDockerTarget;
  nativeResumeId?: string;
  /** Allowlisted Claude conversation identity used by `claude --resume`. */
  claudeResumeId?: string;
  status: SessionRecoveryStatus;
  launch: SessionRecoveryLaunch;
  createdAt: number;
  lastActivityAt?: number;
  recoveredSessionId?: string;
}
