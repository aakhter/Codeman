import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Session } from '../../session.js';
import { ManualRecoveryRequiredError, remoteTmuxSessionName } from '../../tmux-manager.js';
import { probeRemoteRecoveryTarget } from '../../remote-hosts.js';
import { readRemoteCases, readRemoteHosts, toAttachedSessionRemote, toSessionRemote } from '../../remote-hosts.js';
import { readDockerCases, readDockerHosts, toSessionDocker } from '../../docker-hosts.js';
import { getDataDir } from '../../config/instance.js';
import { ApiErrorCode, createErrorResponse, type SessionDocker, type SessionRemote } from '../../types.js';
import type { SessionRecoveryRecord } from '../../types/session-recovery.js';
import { canAccessOwned, getAuthUser } from '../route-helpers.js';
import type { ConfigPort, EventPort, SessionPort } from '../ports/index.js';
import { dismissRecovery, isRecoveryDismissed } from '../../session-recovery-fence.js';

const RecoveryIdSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9._-]+$/);
type RecoveryContext = ConfigPort & EventPort & SessionPort & { mux: ConstructorParameters<typeof Session>[0]['mux'] };
/** Process-local claim fence: route handlers share an event loop, so add-before-await is atomic. */
const activeRecoveryActions = new Set<string>();
/** Tombstones make dismissal win races with an action already past its initial lookup. */

function findRecovery(
  ctx: RecoveryContext,
  id: string,
  request: Parameters<typeof getAuthUser>[0]
): SessionRecoveryRecord | undefined {
  return ctx.store
    .getSessionRecoveries()
    .find((record) => record.id === id && canAccessOwned(getAuthUser(request), record.owner));
}

function conflict(message: string) {
  return createErrorResponse(ApiErrorCode.OPERATION_FAILED, message);
}

/** Maps durable evidence to the launch inputs consumed by local, remote, and Docker mux builders. */
export function recoverySessionConfig(
  record: SessionRecoveryRecord,
  action?: 'reconnect' | 'resume',
  transport: { remote?: SessionRemote; docker?: SessionDocker } = {}
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
    // Docker's real builder receives this top-level field. The mode-specific
    // config remains necessary for non-Docker local/remote builders.
    resumeSessionId: record.transport === 'docker' ? (nativeResumeId ?? record.claudeResumeId) : record.claudeResumeId,
    nativeResumeId,
    codexConfig: record.mode === 'codex' && nativeResumeId ? { resumeSessionId: nativeResumeId } : undefined,
    openCodeConfig: record.mode === 'opencode' && nativeResumeId ? { continueSession: nativeResumeId } : undefined,
  };
}

/** A reconnect is only an SSH/tmux client wrapper around an already-live source. */
export function recoveryCleanupKillsMux(record: SessionRecoveryRecord, action: 'reconnect' | 'resume'): boolean {
  return !(record.transport === 'remote' && action === 'reconnect');
}

async function resolveRecoveryTransport(
  record: SessionRecoveryRecord
): Promise<{ remote?: SessionRemote; docker?: SessionDocker }> {
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

async function remoteIsLive(record: SessionRecoveryRecord, remote: SessionRemote): Promise<boolean> {
  return probeRemoteRecoveryTarget(remote, {
    owned: remote.owned !== false,
    sessionId: record.sourceSessionId,
    remoteSessionName: remote.remoteSessionName,
  });
}

export function registerSessionRecoveryRoutes(app: FastifyInstance, ctx: RecoveryContext): void {
  app.get('/api/session-recoveries', async (req) => ({
    recoveries: ctx.store.getSessionRecoveries().filter((record) => canAccessOwned(getAuthUser(req), record.owner)),
  }));

  for (const action of ['refresh', 'reconnect', 'resume', 'dismiss'] as const) {
    app.post(`/api/session-recoveries/:id/${action}`, async (req, reply) => {
      const parsed = RecoveryIdSchema.safeParse((req.params as { id?: unknown }).id);
      if (!parsed.success)
        return reply.code(400).send(createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid recovery id'));
      const record = findRecovery(ctx, parsed.data, req);
      if (!record) return reply.code(404).send(createErrorResponse(ApiErrorCode.NOT_FOUND, 'Recovery not found'));

      if (action === 'dismiss') {
        dismissRecovery(record.id);
        ctx.store.removeSessionRecovery(record.id);
        return { dismissed: true };
      }
      if (isRecoveryDismissed(record.id))
        return reply.code(404).send(createErrorResponse(ApiErrorCode.NOT_FOUND, 'Recovery not found'));
      if (record.status === 'recovered' || record.recoveredSessionId) {
        return reply.code(409).send(conflict('Recovery has already created a replacement session'));
      }
      if (action === 'refresh') {
        if (!['pending', 'reattachable', 'resumable'].includes(record.status)) {
          return reply.code(409).send(conflict('Recovery cannot be refreshed in its current state'));
        }
        const transport = await resolveRecoveryTransport(record);
        if (isRecoveryDismissed(record.id))
          return reply.code(409).send(conflict('Recovery was dismissed while refresh was in progress'));
        if (record.transport === 'remote' && !transport.remote)
          return reply.code(409).send(conflict('Remote recovery configuration is unavailable'));
        const live = transport.remote ? await remoteIsLive(record, transport.remote) : false;
        if (isRecoveryDismissed(record.id))
          return reply.code(409).send(conflict('Recovery was dismissed while refresh was in progress'));
        const next = {
          ...record,
          status:
            record.transport === 'remote'
              ? live
                ? ('reattachable' as const)
                : record.nativeResumeId || record.claudeResumeId
                  ? ('resumable' as const)
                  : ('unavailable' as const)
              : record.status,
        };
        ctx.store.upsertSessionRecovery(next);
        return { recovery: next, live };
      }
      if (action === 'reconnect' && record.status !== 'reattachable')
        return reply.code(409).send(conflict('Recovery is not reattachable'));
      if (action === 'resume' && record.status !== 'resumable')
        return reply.code(409).send(conflict('Recovery is not resumable'));
      // This must happen before any await below (including remote probing), so
      // two concurrent requests cannot both create a replacement Session.
      if (activeRecoveryActions.has(record.id)) {
        return reply.code(409).send(conflict('Recovery action is already in progress'));
      }
      activeRecoveryActions.add(record.id);

      try {
        if (record.launch.kind === 'manual_required') return reply.code(409).send(conflict(record.launch.hint));
        if (record.transport === 'remote') {
          const transport = await resolveRecoveryTransport(record);
          if (!transport.remote) return reply.code(409).send(conflict('Remote recovery configuration is unavailable'));
          if (action === 'resume' && transport.remote.owned === false) {
            return reply.code(409).send(conflict('Discovered remote sessions are attach-only and cannot be resumed'));
          }
          const live = await remoteIsLive(record, transport.remote);
          if (action === 'reconnect' && !live)
            return reply.code(409).send(conflict('Remote tmux session is no longer live'));
          if (action === 'resume' && live)
            return reply.code(409).send(conflict('Remote tmux session is still live; reconnect instead'));
        } else if (action === 'reconnect') {
          return reply.code(409).send(conflict('Reconnect is available only for a live remote tmux session'));
        }

        const transport = await resolveRecoveryTransport(record);
        if (
          (record.transport === 'remote' && !transport.remote) ||
          (record.transport === 'docker' && !transport.docker)
        ) {
          return reply.code(409).send(conflict('Recovery configuration is unavailable'));
        }
        const session = new Session({
          workingDir: record.workingDir,
          mode: record.mode,
          mux: ctx.mux,
          useMux: true,
          ...recoverySessionConfig(record, action, transport),
        });
        try {
          if (isRecoveryDismissed(record.id))
            return reply.code(409).send(conflict('Recovery was dismissed before launch'));
          await ctx.addSession(session);
          await ctx.setupSessionListeners(session);
          ctx.persistSessionStateNow(session);
          if (isRecoveryDismissed(record.id)) {
            await ctx.cleanupSession(session.id, recoveryCleanupKillsMux(record, action), 'recovery dismissed');
            return reply.code(409).send(conflict('Recovery was dismissed before launch'));
          }
          await session.startInteractive();
          if (isRecoveryDismissed(record.id)) {
            await ctx.cleanupSession(session.id, recoveryCleanupKillsMux(record, action), 'recovery dismissed');
            return reply.code(409).send(conflict('Recovery was dismissed while the action was in progress'));
          }
          const next = { ...record, status: 'recovered' as const, recoveredSessionId: session.id };
          ctx.store.upsertSessionRecovery(next);
          return { recovery: next, session: ctx.getSessionStateWithRespawn(session) };
        } catch (error) {
          if (ctx.sessions.has(session.id)) await ctx.cleanupSession(session.id, false, 'recovery failed');
          if (error instanceof ManualRecoveryRequiredError) return reply.code(409).send(conflict(error.message));
          throw error;
        }
      } finally {
        activeRecoveryActions.delete(record.id);
      }
    });
  }
}
