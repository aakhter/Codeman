/** Shared execution path for explicit and automatic reboot recovery actions. */

import { stat } from 'node:fs/promises';
import { Session } from '../session.js';
import { readRemoteCases, readRemoteHosts, toAttachedSessionRemote, toSessionRemote } from '../remote-hosts.js';
import { readDockerCases, readDockerHosts, toSessionDocker } from '../docker-hosts.js';
import { getDataDir } from '../config/instance.js';
import { ManualRecoveryRequiredError, remoteTmuxSessionName } from '../tmux-manager.js';
import type { SessionDocker, SessionRemote } from '../types.js';
import type { SessionRecoveryRecord } from '../types/session-recovery.js';
import type { StateStore } from '../state-store.js';
import type { SessionPort } from './ports/session-port.js';
import { probeRemoteRecoveryTarget } from '../remote-hosts.js';

export type SessionRecoveryAction = 'reconnect' | 'resume';
export type RecoveryTransport = { remote?: SessionRemote; docker?: SessionDocker };

export type RecoveryExecutionContext = SessionPort & {
  store: StateStore;
  mux: ConstructorParameters<typeof Session>[0]['mux'];
};

export interface RecoveryExecutionSeams {
  resolveTransport?: (record: SessionRecoveryRecord) => Promise<RecoveryTransport>;
  probeRemote?: (record: SessionRecoveryRecord, remote: SessionRemote) => Promise<boolean>;
  isCancelled?: () => boolean;
}

export class SessionRecoveryConflictError extends Error {}

/** Maps durable evidence to the launch inputs consumed by local, remote, and Docker mux builders. */
export function recoverySessionConfig(
  record: SessionRecoveryRecord,
  action?: SessionRecoveryAction,
  transport: RecoveryTransport = {}
) {
  const nativeResumeId = record.nativeResumeId;
  let remote: SessionRemote | undefined = transport.remote;
  if (action === 'reconnect' && remote && remote.owned !== false) {
    remote = { ...remote, remoteSessionName: remoteTmuxSessionName(record.sourceSessionId) };
  }
  return {
    remote,
    docker: transport.docker,
    owner: record.owner,
    resumeSessionId: record.transport === 'docker' ? (nativeResumeId ?? record.claudeResumeId) : record.claudeResumeId,
    nativeResumeId,
    codexConfig: record.mode === 'codex' && nativeResumeId ? { resumeSessionId: nativeResumeId } : undefined,
    openCodeConfig: record.mode === 'opencode' && nativeResumeId ? { continueSession: nativeResumeId } : undefined,
  };
}

/** A reconnect is only an SSH/tmux client wrapper around an already-live source. */
export function recoveryCleanupKillsMux(record: SessionRecoveryRecord, action: SessionRecoveryAction): boolean {
  return !(record.transport === 'remote' && action === 'reconnect');
}

export async function resolveRecoveryTransport(record: SessionRecoveryRecord): Promise<RecoveryTransport> {
  const configDir = getDataDir();
  if (record.transport === 'remote' && record.remote) {
    const host = (await readRemoteHosts(configDir)).find((item) => item.id === record.remote?.hostId);
    if (!host) return {};
    if (record.remote.owned === false && record.remote.remoteSessionName) {
      return { remote: toAttachedSessionRemote(host, record.remote.remoteSessionName, record.workingDir) };
    }
    const remoteCase = (await readRemoteCases(configDir)).find(
      (item) =>
        item.hostId === record.remote?.hostId && item.remotePath === record.workingDir && item.owner === record.owner
    );
    return remoteCase ? { remote: toSessionRemote(host, remoteCase) } : {};
  }
  if (record.transport === 'docker' && record.docker) {
    const host = (await readDockerHosts(configDir)).find((item) => item.id === record.docker?.hostId);
    const dockerCase = (await readDockerCases(configDir)).find(
      (item) =>
        item.hostId === record.docker?.hostId &&
        item.hostWorkspacePath === record.workingDir &&
        item.owner === record.owner
    );
    return host && dockerCase ? { docker: toSessionDocker(host, dockerCase) } : {};
  }
  return {};
}

export async function recoveryRemoteIsLive(record: SessionRecoveryRecord, remote: SessionRemote): Promise<boolean> {
  return probeRemoteRecoveryTarget(remote, {
    owned: remote.owned !== false,
    sessionId: record.sourceSessionId,
    remoteSessionName: remote.remoteSessionName,
  });
}

function cancelled(seams: RecoveryExecutionSeams): boolean {
  return seams.isCancelled?.() === true;
}

async function cleanupCancelled(
  ctx: RecoveryExecutionContext,
  record: SessionRecoveryRecord,
  action: SessionRecoveryAction,
  sessionId: string
): Promise<void> {
  if (!recoveryCleanupKillsMux(record, action)) await ctx.cleanupRecoveryReconnectWrapper(sessionId);
  else await ctx.cleanupSession(sessionId, true, 'recovery cancelled');
}

/** Execute one already-authorized recovery action and persist its terminal record. */
export async function executeSessionRecovery(
  ctx: RecoveryExecutionContext,
  record: SessionRecoveryRecord,
  action: SessionRecoveryAction,
  seams: RecoveryExecutionSeams = {}
): Promise<{ recovery: SessionRecoveryRecord; session: ReturnType<SessionPort['getSessionStateWithRespawn']> }> {
  if (record.launch.kind === 'manual_required' && action !== 'reconnect') {
    throw new SessionRecoveryConflictError(record.launch.hint);
  }

  if (record.transport === 'local' && !(await stat(record.workingDir).catch(() => null))?.isDirectory()) {
    throw new SessionRecoveryConflictError('Original working directory is unavailable');
  }
  const resolveTransport = seams.resolveTransport ?? resolveRecoveryTransport;
  const probeRemote = seams.probeRemote ?? recoveryRemoteIsLive;
  const transport = await resolveTransport(record);
  if (record.transport === 'remote') {
    if (!transport.remote) throw new SessionRecoveryConflictError('Remote recovery configuration is unavailable');
    if (action === 'resume' && transport.remote.owned === false) {
      throw new SessionRecoveryConflictError('Discovered remote sessions are attach-only and cannot be resumed');
    }
    const live = await probeRemote(record, transport.remote);
    if (action === 'reconnect' && !live)
      throw new SessionRecoveryConflictError('Remote tmux session is no longer live');
    if (action === 'resume' && live)
      throw new SessionRecoveryConflictError('Remote tmux session is still live; reconnect instead');
  } else if (action === 'reconnect') {
    throw new SessionRecoveryConflictError('Reconnect is available only for a live remote tmux session');
  }
  if (record.transport === 'docker' && !transport.docker) {
    throw new SessionRecoveryConflictError('Recovery configuration is unavailable');
  }

  const session = new Session({
    workingDir: record.workingDir,
    mode: record.mode,
    name: record.name,
    mux: ctx.mux,
    useMux: true,
    ...recoverySessionConfig(record, action, transport),
  });
  try {
    if (cancelled(seams)) throw new SessionRecoveryConflictError('Recovery was cancelled before launch');
    await ctx.addSession(session);
    await ctx.setupSessionListeners(session);
    ctx.persistSessionStateNow(session);
    if (cancelled(seams)) {
      await cleanupCancelled(ctx, record, action, session.id);
      throw new SessionRecoveryConflictError('Recovery was cancelled before launch');
    }
    await session.startInteractive();
    if (cancelled(seams)) {
      await cleanupCancelled(ctx, record, action, session.id);
      throw new SessionRecoveryConflictError('Recovery was cancelled while the action was in progress');
    }
    const next = {
      ...record,
      status: 'recovered' as const,
      restoreEvidence: action === 'reconnect' ? ('remote_live' as const) : ('launch_returned' as const),
      recoveredSessionId: session.id,
    };
    ctx.store.upsertSessionRecovery(next);
    return { recovery: next, session: ctx.getSessionStateWithRespawn(session) };
  } catch (error) {
    if (ctx.sessions.has(session.id) && !(error instanceof SessionRecoveryConflictError && cancelled(seams))) {
      await ctx.cleanupSession(session.id, false, 'recovery failed');
    }
    if (error instanceof ManualRecoveryRequiredError) throw new SessionRecoveryConflictError(error.message);
    throw error;
  }
}
