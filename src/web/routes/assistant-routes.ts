/** Assistant registry routes. Request execution is deliberately gated until COD-490. */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AssistantRegistry, AssistantConflict, type AssistantSession } from '../../assistant-registry.js';
import { ApiErrorCode, createErrorResponse } from '../../types.js';
import { getAuthUser, ownerFor, canAccessOwned, parseBody } from '../route-helpers.js';
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
const unavailable = () =>
  createErrorResponse(
    ApiErrorCode.OPERATION_FAILED,
    'Assistant request execution is unavailable until COD-490 is installed'
  );

export function registerAssistantRoutes(
  app: FastifyInstance,
  registry: AssistantRegistry,
  sessions: ReadonlyMap<string, AssistantSession>
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
    capabilities: { localCodex: true, requestExecution: false, requiresDesktopHandoff: true },
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
  // Explicit capability gate. Do not synthesize a result from last-response or
  // silently submit through the legacy terminal API when the engine is absent.
  app.post('/api/assistants/:id/requests', async (req, reply) => {
    get(req);
    return reply.code(503).send(unavailable());
  });
  app.get('/api/assistants/:id/requests', async (req, reply) => {
    get(req);
    return reply.code(503).send(unavailable());
  });
  app.get('/api/assistant-requests/:id', async (_req, reply) => reply.code(503).send(unavailable()));
  app.post('/api/assistant-requests/:id/cancel', async (_req, reply) => reply.code(503).send(unavailable()));
}
