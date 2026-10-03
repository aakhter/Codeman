import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Session } from '../../session.js';
import { resolveNativeResumeIdForRecovery } from '../../native-session-identity.js';
import { ApiErrorCode, createErrorResponse, type SessionDocker, type SessionRemote } from '../../types.js';
import type { SessionRecoveryRecord } from '../../types/session-recovery.js';
import { canAccessOwned, getAuthUser } from '../route-helpers.js';
import type { ConfigPort, EventPort, SessionPort } from '../ports/index.js';
import { dismissRecovery, isRecoveryDismissed } from '../../session-recovery-fence.js';
import {
  executeSessionRecovery,
  recoveryRemoteIsLive,
  resolveRecoveryTransport,
  SessionRecoveryConflictError,
} from '../session-recovery-service.js';

export { recoveryCleanupKillsMux, recoverySessionConfig } from '../session-recovery-service.js';

const RecoveryIdSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9._-]+$/);
type RecoveryContext = ConfigPort & EventPort & SessionPort & { mux: ConstructorParameters<typeof Session>[0]['mux'] };
type RecoveryTestSeams = {
  probeRecoveryTarget?: (record: SessionRecoveryRecord, remote: SessionRemote) => Promise<boolean>;
  resolveRecoveryTransport?: (
    record: SessionRecoveryRecord
  ) => Promise<{ remote?: SessionRemote; docker?: SessionDocker }>;
};
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

export function registerSessionRecoveryRoutes(app: FastifyInstance, ctx: RecoveryContext): void {
  const seams = ctx as RecoveryContext & RecoveryTestSeams;
  const resolveTransport = (record: SessionRecoveryRecord) =>
    seams.resolveRecoveryTransport?.(record) ?? resolveRecoveryTransport(record);
  const probe = (record: SessionRecoveryRecord, remote: SessionRemote) =>
    seams.probeRecoveryTarget?.(record, remote) ?? recoveryRemoteIsLive(record, remote);
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
        const refreshLocalCodex =
          record.transport === 'local' && record.mode === 'codex' && record.launch.kind === 'built-in';
        if (
          !['pending', 'reattachable', 'resumable'].includes(record.status) &&
          !(refreshLocalCodex && record.status === 'unavailable')
        ) {
          return reply.code(409).send(conflict('Recovery cannot be refreshed in its current state'));
        }
        const nativeResumeId = refreshLocalCodex
          ? await resolveNativeResumeIdForRecovery({
              id: record.sourceSessionId,
              pid: null,
              status: 'idle',
              currentTaskId: null,
              mode: record.mode,
              workingDir: record.workingDir,
              createdAt: record.createdAt,
              lastActivityAt: record.lastActivityAt ?? record.createdAt,
            })
          : record.nativeResumeId;
        const transport = await resolveTransport(record);
        if (isRecoveryDismissed(record.id))
          return reply.code(409).send(conflict('Recovery was dismissed while refresh was in progress'));
        if (record.transport === 'remote' && !transport.remote)
          return reply.code(409).send(conflict('Remote recovery configuration is unavailable'));
        const live = transport.remote ? await probe(record, transport.remote) : false;
        if (isRecoveryDismissed(record.id))
          return reply.code(409).send(conflict('Recovery was dismissed while refresh was in progress'));
        const next = {
          ...record,
          ...(nativeResumeId ? { nativeResumeId } : {}),
          status:
            record.transport === 'remote'
              ? live
                ? ('reattachable' as const)
                : record.nativeResumeId || record.claudeResumeId
                  ? ('resumable' as const)
                  : ('unavailable' as const)
              : refreshLocalCodex
                ? nativeResumeId
                  ? ('resumable' as const)
                  : ('unavailable' as const)
                : record.status,
        };
        const current = findRecovery(ctx, record.id, req);
        if (
          !current ||
          current.status === 'recovered' ||
          current.recoveredSessionId ||
          activeRecoveryActions.has(record.id)
        )
          return reply.code(409).send(conflict('Recovery changed while refresh was in progress'));
        ctx.store.upsertSessionRecovery(next);
        return { recovery: next, live };
      }
      if (action === 'reconnect' && !['reattachable', 'manual_required'].includes(record.status))
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
        try {
          return await executeSessionRecovery(ctx, record, action, {
            resolveTransport,
            probeRemote: probe,
            isCancelled: () => isRecoveryDismissed(record.id),
          });
        } catch (error) {
          if (error instanceof SessionRecoveryConflictError) return reply.code(409).send(conflict(error.message));
          throw error;
        }
      } finally {
        activeRecoveryActions.delete(record.id);
      }
    });
  }
}
