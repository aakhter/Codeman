/** Utilities for producing sanitized, durable session recovery records. */

import type { SessionState } from './types/session.js';
import type {
  SessionRecoveryLaunch,
  SessionRecoveryRecord,
  SessionRecoveryStatus,
  SessionRecoveryTransport,
} from './types/session-recovery.js';

export interface CreateRecoveryRecordOptions {
  transport?: SessionRecoveryTransport;
  launch?: SessionRecoveryLaunch;
}

/**
 * Creates a recovery record by allowlisting safe session metadata. Runtime data,
 * provider configuration, credentials, environment overrides, and raw diagnostics
 * are deliberately not copied from SessionState.
 */
export function createRecoveryRecord(
  session: SessionState,
  options: CreateRecoveryRecordOptions = {}
): SessionRecoveryRecord {
  const transport = options.transport ?? (session.docker ? 'docker' : session.remote ? 'remote' : 'local');
  const launch = options.launch ?? { kind: 'built-in' };
  const nativeResumeId = session.nativeResumeId ?? undefined;
  const status = classifyRecoveryStatus(transport, launch, nativeResumeId, session.resumeSessionId);

  return {
    id: `recovery-${session.id}`,
    sourceSessionId: session.id,
    ...(session.owner ? { owner: session.owner } : {}),
    mode: session.mode ?? 'shell',
    workingDir: session.workingDir,
    transport,
    ...(nativeResumeId ? { nativeResumeId } : {}),
    status,
    launch: { ...launch },
    createdAt: session.createdAt,
    ...(session.lastActivityAt !== undefined ? { lastActivityAt: session.lastActivityAt } : {}),
  };
}

function classifyRecoveryStatus(
  transport: SessionRecoveryTransport,
  launch: SessionRecoveryLaunch,
  nativeResumeId: string | undefined,
  claudeResumeId: string | undefined
): SessionRecoveryStatus {
  if (launch.kind === 'manual_required') return 'manual_required';
  if (transport === 'remote' || transport === 'docker') return 'reattachable';
  if (nativeResumeId || claudeResumeId) return 'resumable';
  return 'unavailable';
}
