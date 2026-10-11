/** Owner-scoped assistant management, handoff and durable request routes. */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AssistantRegistry, AssistantConflict, type AssistantSession } from '../../assistant-registry.js';
import { ApiErrorCode, createErrorResponse } from '../../types.js';
import { getAuthUser, ownerFor, canAccessOwned, parseBody } from '../route-helpers.js';
import type { AssistantRequestManager } from '../../assistant-request-manager.js';
import type { AssistantDefinition } from '../../types/assistant.js';

const Params = z.object({ id: z.uuid() });
const Create = z
  .object({ name: z.string().trim().min(1).max(60), slug: z.string().regex(/^[a-z][a-z0-9-]{0,59}$/) })
  .strict();
const Update = z
  .object({
    expectedRevision: z.number().int().positive(),
    name: z.string().trim().min(1).max(60).optional(),
    enabled: z.boolean().optional(),
  })
  .strict()
  .refine((v) => v.name !== undefined || v.enabled !== undefined);
const Bind = z
  .object({
    sessionId: z.string().min(1).max(100),
    expectedRevision: z.number().int().positive(),
    expectedGeneration: z.number().int().nonnegative(),
  })
  .strict();
const Token = z
  .object({
    name: z.string().trim().min(1).max(60),
    scopes: z
      .array(z.enum(['read', 'submit', 'cancel']))
      .min(1)
      .max(3),
  })
  .strict();

export function registerAssistantRoutes(
  app: FastifyInstance,
  registry: AssistantRegistry,
  sessions: ReadonlyMap<string, AssistantSession>,
  requests?: AssistantRequestManager
): void {
  const visible = (req: FastifyRequest, a: AssistantDefinition): boolean =>
    req.assistantPrincipal
      ? a.id === req.assistantPrincipal.assistantId && a.owner === req.assistantPrincipal.owner
      : canAccessOwned(getAuthUser(req), a.owner);
  const get = (req: FastifyRequest): AssistantDefinition => {
    const { id } = parseBody(Params, req.params);
    const a = registry.store.get(id);
    if (!a || !visible(req, a)) throw { statusCode: 404, body: createErrorResponse(ApiErrorCode.NOT_FOUND) };
    return a;
  };
  const expose = (a: AssistantDefinition) => ({
    ...a,
    capabilities: {
      localCodex: a.mode === 'codex',
      supportedModes: ['codex', 'claude', 'opencode'],
      requestExecution: false,
      requiresDesktopHandoff: true,
      ...requests?.availability(a),
    },
  });
  const mutate = async <T>(operation: () => T | Promise<T>): Promise<T> => {
    try {
      return await operation();
    } catch (err) {
      if (err instanceof AssistantConflict)
        throw { statusCode: 409, body: createErrorResponse(ApiErrorCode.CONFLICT, err.message) };
      throw err;
    }
  };
  app.addHook('onSend', async (req, reply, payload) => {
    if (req.url.startsWith('/api/assistants') || req.url.startsWith('/api/assistant-requests'))
      reply.header('Cache-Control', 'no-store');
    return payload;
  });
  app.get('/api/assistants', async (req) => ({
    success: true,
    data: {
      assistants: registry.store
        .list()
        .filter((a) => visible(req, a))
        .map(expose),
    },
  }));
  app.post('/api/assistants', async (req) => {
    const { name, slug } = parseBody(Create, req.body);
    return { success: true, data: expose(await mutate(() => registry.create(ownerFor(req), name, slug))) };
  });
  app.get('/api/assistants/:id', async (req) => ({ success: true, data: expose(get(req)) }));
  app.patch('/api/assistants/:id', async (req) => {
    const a = get(req);
    const { expectedRevision, ...changes } = parseBody(Update, req.body);
    return { success: true, data: expose(await mutate(() => registry.update(a, expectedRevision, changes))) };
  });
  app.delete('/api/assistants/:id', async (req) => {
    const a = get(req);
    const { expectedRevision } = parseBody(
      z.object({ expectedRevision: z.number().int().positive() }).strict(),
      req.body
    );
    await mutate(() => registry.remove(a, expectedRevision));
    return { success: true, data: { deleted: true } };
  });
  app.post('/api/assistants/:id/binding', async (req) => {
    const a = get(req);
    const input = parseBody(Bind, req.body);
    const session = sessions.get(input.sessionId);
    if (!session || session.owner !== a.owner || !canAccessOwned(getAuthUser(req), session.owner))
      throw { statusCode: 404, body: createErrorResponse(ApiErrorCode.NOT_FOUND) };
    return {
      success: true,
      data: expose(await mutate(() => registry.bind(a, input.expectedRevision, input.expectedGeneration, session))),
    };
  });
  app.post('/api/assistants/:id/tokens', async (req) => {
    const a = get(req);
    const input = parseBody(Token, req.body);
    return { success: true, data: registry.store.issueToken(a, input.name, input.scopes) };
  });
  app.get('/api/assistants/:id/tokens', async (req) => ({
    success: true,
    data: { tokens: registry.store.listTokens(get(req).id) },
  }));
  app.delete('/api/assistants/:id/tokens/:tokenId', async (req, reply) => {
    const a = get(req);
    const { tokenId } = parseBody(z.object({ id: z.uuid(), tokenId: z.uuid() }), req.params);
    if (!registry.store.revokeToken(a.id, tokenId))
      return reply.code(404).send(createErrorResponse(ApiErrorCode.NOT_FOUND));
    return { success: true, data: { revoked: true } };
  });
  const engine = (): AssistantRequestManager => {
    if (!requests)
      throw {
        statusCode: 503,
        body: createErrorResponse(ApiErrorCode.OPERATION_FAILED, 'Assistant execution engine is unavailable'),
      };
    return requests;
  };
  const request = (req: FastifyRequest) => {
    const { id } = parseBody(Params, req.params);
    const r = engine().store.get(id);
    const a = r && registry.store.get(r.assistantId);
    if (!r || !a || !visible(req, a) || r.owner !== a.owner)
      throw { statusCode: 404, body: createErrorResponse(ApiErrorCode.NOT_FOUND) };
    return r;
  };
  app.post('/api/assistants/:id/handoff', async (req) => {
    const a = get(req);
    const input = parseBody(
      z.object({ expectedRevision: z.number().int().positive(), composerEmpty: z.literal(true) }).strict(),
      req.body
    );
    await mutate(() => engine().handoff(a, input.expectedRevision, input.composerEmpty));
    return { success: true, data: expose(registry.store.get(a.id)!) };
  });
  app.post('/api/assistants/:id/take-control', async (req) => {
    const a = get(req);
    await mutate(() => engine().takeControl(a));
    return { success: true, data: expose(registry.store.get(a.id)!) };
  });
  app.post('/api/assistants/:id/requests', async (req) => {
    const a = get(req);
    const input = parseBody(
      z
        .object({ text: z.string().min(1).max(20000), idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/) })
        .strict(),
      req.body
    );
    return {
      success: true,
      data: await mutate(() => engine().submit(a, input.text, input.idempotencyKey, req.assistantPrincipal?.tokenId)),
    };
  });
  app.get('/api/assistants/:id/requests', async (req) => ({
    success: true,
    data: {
      requests: engine()
        .store.list()
        .filter((r) => r.assistantId === get(req).id),
    },
  }));
  app.get('/api/assistant-requests/:id', async (req) => ({ success: true, data: request(req) }));
  app.post('/api/assistant-requests/:id/answer', async (req) => {
    const r = request(req);
    const input = parseBody(
      z
        .object({
          questionKey: z.string().min(1).max(500),
          idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
          answers: z
            .record(
              z.string().min(1).max(200),
              z
                .object({
                  answers: z.array(z.string().trim().min(1).max(20000)).length(1),
                })
                .strict()
            )
            .refine((a) => Object.keys(a).length > 0 && Object.keys(a).length <= 10),
        })
        .strict(),
      req.body
    );
    return {
      success: true,
      data: await mutate(() => engine().answer(r, input.questionKey, input.answers, input.idempotencyKey)),
    };
  });
  app.post('/api/assistant-requests/:id/cancel', async (req) => ({
    success: true,
    data: await mutate(() => engine().cancel(request(req))),
  }));
  app.post('/api/assistant-requests/:id/reconcile', async (req) => {
    const r = request(req);
    const { acknowledgeSideEffects } = parseBody(
      z.object({ acknowledgeSideEffects: z.literal(true) }).strict(),
      req.body
    );
    return { success: true, data: await mutate(() => engine().reconcile(r, acknowledgeSideEffects)) };
  });
}
