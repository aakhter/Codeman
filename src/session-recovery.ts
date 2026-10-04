/** Utilities for producing sanitized, durable session recovery records. */

import type { SessionState } from './types/session.js';
import type { MuxSession } from './mux-interface.js';
import { resolveCodexRecoveryStrategy } from './codex-command-profiles.js';
import type {
  SessionRecoveryLaunch,
  SessionRecoveryRecord,
  SessionRecoveryStatus,
  SessionRecoveryTransport,
} from './types/session-recovery.js';
import { clearRecoveryDismissal } from './session-recovery-fence.js';

export interface CreateRecoveryRecordOptions {
  transport?: SessionRecoveryTransport;
  launch?: SessionRecoveryLaunch;
}

export interface SnapshotRecoveryOptions {
  resolveNativeResumeId?: (session: SessionState) => Promise<string | null>;
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
  const launch = sanitizeRecoveryLaunch(options.launch ?? deriveRecoveryLaunch(session));
  const nativeResumeId =
    session.nativeResumeId ?? (session.mode === 'codex' ? session.codexConfig?.resumeSessionId : undefined);
  const claudeResumeId =
    session.mode === 'claude'
      ? (session.claudeSessionChain?.at(-1) ?? session.claudeSessionId ?? session.resumeSessionId)
      : undefined;
  const status = classifyRecoveryStatus(transport, launch, nativeResumeId, claudeResumeId);

  return {
    id: `recovery-${session.id}`,
    sourceSessionId: session.id,
    ...(session.name ? { name: session.name } : {}),
    ...(session.customModel
      ? {
          providerSelection: {
            endpointId: session.customModel.endpointId,
            modelId: session.customModel.modelId,
            ...(session.customModel.label ? { label: session.customModel.label } : {}),
          },
        }
      : {}),
    ...(session.owner ? { owner: session.owner } : {}),
    mode: session.mode ?? 'shell',
    workingDir: session.workingDir,
    transport,
    ...(session.remote
      ? {
          remote: {
            hostId: session.remote.hostId,
            ...(session.remote.owned !== undefined ? { owned: session.remote.owned } : {}),
            ...(session.remote.remoteSessionName !== undefined
              ? { remoteSessionName: session.remote.remoteSessionName }
              : {}),
          },
        }
      : {}),
    ...(session.docker
      ? { docker: { hostId: session.docker.hostId, containerName: session.docker.containerName } }
      : {}),
    ...(nativeResumeId ? { nativeResumeId } : {}),
    ...(claudeResumeId ? { claudeResumeId } : {}),
    status,
    launch: { ...launch },
    createdAt: session.createdAt,
    ...(session.lastActivityAt !== undefined ? { lastActivityAt: session.lastActivityAt } : {}),
  };
}

/**
 * Custom Codex launch strings are opaque. Only a selected saved profile with a
 * declared template can be recovered automatically; every other override is a
 * manual action rather than a string rewrite.
 */
function deriveRecoveryLaunch(session: SessionState): SessionRecoveryLaunch {
  const privateState = session as SessionState & {
    __codexProviderIdentity?: { credentialSource?: string; codexHome?: string };
    __envOverrides?: Record<string, unknown>;
    __customModel?: unknown;
    __resolvedCodexCommand?: string;
  };
  // Recovery must not silently switch custom endpoints, credentials, homes or launchers.
  if (
    session.customModel ||
    privateState.__customModel ||
    Object.keys(privateState.__envOverrides ?? {}).length > 0 ||
    privateState.__codexProviderIdentity?.codexHome ||
    privateState.__codexProviderIdentity?.credentialSource === 'session-key' ||
    session.codexConfig?.baseCommand ||
    privateState.__resolvedCodexCommand
  ) {
    return { kind: 'manual_required', hint: SAFE_MANUAL_RECOVERY_HINT };
  }
  if (session.mode !== 'codex') return { kind: 'built-in' };

  const remote = session.remote;
  const command = remote?.commands?.codex ?? session.docker?.commands?.codex;
  if (command === undefined) return { kind: 'built-in' };

  const strategy = resolveCodexRecoveryStrategy(
    { command, resumeCommandTemplate: remote?.codexResumeCommandTemplate },
    session.nativeResumeId ?? ''
  );
  if (strategy.kind === 'template' && remote?.codexCommandProfileId) {
    return { kind: 'template', templateId: remote.codexCommandProfileId };
  }
  return { kind: 'manual_required', hint: SAFE_MANUAL_RECOVERY_HINT };
}

/**
 * Persist recovery candidates for managed mux sessions that disappeared across a reboot.
 *
 * This is intentionally metadata-only: it neither attaches nor launches a CLI, connects
 * remotely, sends input, nor waits for any runtime operation. Callers capture mux metadata
 * before reconciliation because mux implementations may discard dead entries while reporting
 * them; this function is invoked only after reconciliation has identified the dead IDs.
 */
export async function snapshotDeadSessionRecoveries(
  store: RecoverySnapshotStore,
  deadSessionIds: readonly string[],
  muxSessionsBeforeReconcile: ReadonlyMap<string, MuxSession>,
  options: SnapshotRecoveryOptions = {}
): Promise<SessionRecoveryRecord[]> {
  if (deadSessionIds.length === 0) return [];

  const existingSourceSessionIds = new Set(store.getSessionRecoveries().map((recovery) => recovery.sourceSessionId));
  const created: SessionRecoveryRecord[] = [];
  for (const sessionId of deadSessionIds) {
    // A previous boot has already preserved this candidate (including terminal/recovered
    // records), so never create another record or regress a recovered record back to pending.
    if (existingSourceSessionIds.has(sessionId)) continue;

    const savedState = store.getSession(sessionId);
    if (!savedState) continue;

    const muxSession = muxSessionsBeforeReconcile.get(sessionId);
    let source: SessionState = {
      ...savedState,
      mode: savedState.mode ?? muxSession?.mode,
      remote: savedState.remote ?? muxSession?.remote,
      docker: savedState.docker ?? muxSession?.docker,
      owner: muxSession?.owner ?? savedState.owner,
    };
    if (!source.nativeResumeId && options.resolveNativeResumeId) {
      const nativeResumeId = await options.resolveNativeResumeId(source).catch(() => null);
      if (nativeResumeId) source = { ...source, nativeResumeId };
    }
    const recovery = createRecoveryRecord(source);
    clearRecoveryDismissal(recovery.id);
    store.upsertSessionRecovery(recovery);
    created.push(recovery);
  }
  return created;
}

/** Select the only automatic action whose prerequisites have already been proven. */
export function planAutomaticRecovery(
  record: SessionRecoveryRecord,
  remoteLive: boolean
): 'reconnect' | 'resume' | null {
  if (record.transport === 'remote' && record.remote?.owned !== false && remoteLive) return 'reconnect';
  if (record.status !== 'resumable' || record.launch.kind === 'manual_required') return null;
  return 'resume';
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
  if (transport === 'remote') return 'reattachable';
  if (transport === 'docker') return nativeResumeId || claudeResumeId ? 'resumable' : 'unavailable';
  if (nativeResumeId || claudeResumeId) return 'resumable';
  return 'unavailable';
}
