/** Narrow bearer principal. Never accepted for terminal, session, settings, or management routes. */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AssistantStore } from '../../assistant-store.js';
import type { AssistantPrincipal, AssistantScope } from '../../types/assistant.js';
import { isMultiUserMode } from '../../config/multiuser.js';
import { findUser } from '../../user-store.js';
import { ApiErrorCode, createErrorResponse } from '../../types.js';

declare module 'fastify' {
  interface FastifyRequest {
    assistantPrincipal?: AssistantPrincipal;
  }
}

function requiredScope(req: FastifyRequest, principal: AssistantPrincipal): AssistantScope | undefined {
  const path = req.url.split('?')[0];
  const assistant = `/api/assistants/${principal.assistantId}`;
  if (req.method === 'GET' && (path === '/api/assistants' || path === assistant)) return 'read';
  if (path === `${assistant}/requests`) {
    if (req.method === 'GET') return 'read';
    if (req.method === 'POST') return 'submit';
  }
  if (/^\/api\/assistant-requests\/[a-zA-Z0-9-]+$/.test(path) && req.method === 'GET') return 'read';
  if (/^\/api\/assistant-requests\/[a-zA-Z0-9-]+\/cancel$/.test(path) && req.method === 'POST') return 'cancel';
  if (/^\/api\/assistant-requests\/[a-zA-Z0-9-]+\/answer$/.test(path) && req.method === 'POST') return 'submit';
  return undefined;
}

export function registerAssistantTokenAuth(app: FastifyInstance, store?: AssistantStore): void {
  if (!app.hasRequestDecorator('assistantPrincipal')) app.decorateRequest('assistantPrincipal', undefined);
  let tokenStore = store;
  app.addHook('onRequest', async (req, reply) => {
    const authorization = req.headers.authorization;
    if (!authorization || !/^Bearer(?:\s|$)/i.test(authorization)) return;
    let principal: AssistantPrincipal | undefined;
    try {
      tokenStore ??= new AssistantStore();
      principal = tokenStore.authenticate(authorization.slice(7));
    } catch {
      return reply
        .code(503)
        .send(createErrorResponse(ApiErrorCode.OPERATION_FAILED, 'Assistant credentials are unavailable'));
    }
    if (!principal) return reply.code(401).send(createErrorResponse(ApiErrorCode.UNAUTHORIZED));
    if (isMultiUserMode()) {
      const user = principal.owner ? await findUser(principal.owner) : undefined;
      if (!user || user.disabled || user.mustChangePassword)
        return reply.code(401).send(createErrorResponse(ApiErrorCode.UNAUTHORIZED));
      req.authUser = { username: user.username, role: 'user' };
    } else if (principal.owner !== undefined) {
      // Switching ownership mode must not promote an old user's token to admin.
      return reply.code(401).send(createErrorResponse(ApiErrorCode.UNAUTHORIZED));
    }
    const scope = requiredScope(req, principal);
    if (!scope || !principal.scopes.includes(scope))
      return reply.code(403).send(createErrorResponse(ApiErrorCode.FORBIDDEN));
    req.assistantPrincipal = principal;
    reply.header('Cache-Control', 'no-store');
  });
}
