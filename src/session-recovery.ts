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

const SAFE_MANUAL_RECOVERY_HINT =
  'Manual recovery is required. Start a new session from the original working directory.';

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
  const launch = sanitizeRecoveryLaunch(options.launch ?? { kind: 'built-in' });
  const nativeResumeId = session.nativeResumeId ?? undefined;
  const claudeResumeId = session.resumeSessionId ?? undefined;
  const status = classifyRecoveryStatus(transport, launch, nativeResumeId, claudeResumeId);

  return {
    id: `recovery-${session.id}`,
    sourceSessionId: session.id,
    ...(session.owner ? { owner: session.owner } : {}),
    mode: session.mode ?? 'shell',
    workingDir: session.workingDir,
    transport,
    ...(nativeResumeId ? { nativeResumeId } : {}),
    ...(claudeResumeId ? { claudeResumeId } : {}),
    status,
    launch: { ...launch },
    createdAt: session.createdAt,
    ...(session.lastActivityAt !== undefined ? { lastActivityAt: session.lastActivityAt } : {}),
  };
}

function sanitizeRecoveryLaunch(launch: SessionRecoveryLaunch): SessionRecoveryLaunch {
  if (launch.kind !== 'manual_required') return { ...launch };
  return { kind: 'manual_required', hint: SAFE_MANUAL_RECOVERY_HINT };
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
