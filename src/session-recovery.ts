/** Utilities for producing sanitized, durable session recovery records. */

import type { SessionState } from './types/session.js';
import type { MuxSession } from './mux-interface.js';
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

/** The small StateStore surface needed while boot reconciliation still has saved state available. */
export interface RecoverySnapshotStore {
  getSession(id: string): SessionState | null;
  getSessionRecoveries(): SessionRecoveryRecord[];
  upsertSessionRecovery(recovery: SessionRecoveryRecord): void;
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

/**
 * Persist recovery candidates for managed mux sessions that disappeared across a reboot.
 *
 * This is intentionally metadata-only: it neither attaches nor launches a CLI, connects
 * remotely, sends input, nor waits for any runtime operation. Callers capture mux metadata
 * before reconciliation because mux implementations may discard dead entries while reporting
 * them; this function is invoked only after reconciliation has identified the dead IDs.
 */
export function snapshotDeadSessionRecoveries(
  store: RecoverySnapshotStore,
  deadSessionIds: readonly string[],
  muxSessionsBeforeReconcile: ReadonlyMap<string, MuxSession>
): void {
  if (deadSessionIds.length === 0) return;

  const existingSourceSessionIds = new Set(store.getSessionRecoveries().map((recovery) => recovery.sourceSessionId));
  for (const sessionId of deadSessionIds) {
    // A previous boot has already preserved this candidate (including terminal/recovered
    // records), so never create another record or regress a recovered record back to pending.
    if (existingSourceSessionIds.has(sessionId)) continue;

    const savedState = store.getSession(sessionId);
    if (!savedState) continue;

    const muxSession = muxSessionsBeforeReconcile.get(sessionId);
    const source = {
      ...savedState,
      mode: savedState.mode ?? muxSession?.mode,
      remote: savedState.remote ?? muxSession?.remote,
      docker: savedState.docker ?? muxSession?.docker,
      owner: muxSession?.owner ?? savedState.owner,
    };
    store.upsertSessionRecovery(createRecoveryRecord(source));
  }
}

/** Returns a fresh launch descriptor that cannot retain caller diagnostics in manual hints. */
export function sanitizeRecoveryLaunch(launch: SessionRecoveryLaunch): SessionRecoveryLaunch {
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
