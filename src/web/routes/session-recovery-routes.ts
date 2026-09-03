import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Session } from '../../session.js';
import { ManualRecoveryRequiredError } from '../../tmux-manager.js';
import { probeRemoteRecoveryTarget } from '../../remote-hosts.js';
import { ApiErrorCode, createErrorResponse } from '../../types.js';
import type { SessionRecoveryRecord } from '../../types/session-recovery.js';
import { canAccessOwned, getAuthUser } from '../route-helpers.js';
import type { ConfigPort, EventPort, SessionPort } from '../ports/index.js';

const RecoveryIdSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9._-]+$/);
type RecoveryContext = ConfigPort & EventPort & SessionPort & { mux: ConstructorParameters<typeof Session>[0]['mux'] };

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

async function remoteIsLive(record: SessionRecoveryRecord): Promise<boolean> {
  if (!record.remote) return false;
  return probeRemoteRecoveryTarget(record.remote, {
    owned: record.remote.owned !== false,
    sessionId: record.sourceSessionId,
    remoteSessionName: record.remote.remoteSessionName,
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
        ctx.store.removeSessionRecovery(record.id);
        return { dismissed: true };
      }
      if (action === 'refresh') {
        const live = record.transport === 'remote' ? await remoteIsLive(record) : false;
        const next = { ...record, status: live ? ('reattachable' as const) : record.status };
        ctx.store.upsertSessionRecovery(next);
        return { recovery: next, live };
      }
      if (record.launch.kind === 'manual_required') return reply.code(409).send(conflict(record.launch.hint));
      if (record.transport === 'remote') {
        if (!record.remote) return reply.code(409).send(conflict('Remote recovery metadata is unavailable'));
        if (action === 'resume' && record.remote.owned === false) {
          return reply.code(409).send(conflict('Discovered remote sessions are attach-only and cannot be resumed'));
        }
        const live = await remoteIsLive(record);
        if (action === 'reconnect' && !live)
          return reply.code(409).send(conflict('Remote tmux session is no longer live'));
        if (action === 'resume' && live)
          return reply.code(409).send(conflict('Remote tmux session is still live; reconnect instead'));
      } else if (action === 'reconnect') {
        return reply.code(409).send(conflict('Reconnect is available only for a live remote tmux session'));
      }

      const session = new Session({
        workingDir: record.workingDir,
        mode: record.mode,
        mux: ctx.mux,
        useMux: true,
        remote: record.remote,
        docker: record.docker,
        owner: record.owner,
        resumeSessionId: record.claudeResumeId,
        nativeResumeId: record.nativeResumeId,
        codexConfig:
          record.mode === 'codex' && record.nativeResumeId ? { resumeSessionId: record.nativeResumeId } : undefined,
        openCodeConfig:
          record.mode === 'opencode' && record.nativeResumeId ? { continueSession: record.nativeResumeId } : undefined,
      });
      try {
        await ctx.addSession(session);
        await ctx.setupSessionListeners(session);
        ctx.persistSessionStateNow(session);
        await session.startInteractive();
        const next = { ...record, status: 'recovered' as const, recoveredSessionId: session.id };
        ctx.store.upsertSessionRecovery(next);
        return { recovery: next, session: ctx.getSessionStateWithRespawn(session) };
      } catch (error) {
        if (ctx.sessions.has(session.id)) await ctx.cleanupSession(session.id, false, 'recovery failed');
        if (error instanceof ManualRecoveryRequiredError) return reply.code(409).send(conflict(error.message));
        throw error;
      }
    });
  }
}
