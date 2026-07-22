/**
 * @fileoverview Source routes for COD-65 Reference / source manager.
 *
 * Endpoints:
 *   GET    /api/sessions/:id/sources           — list sources for a session
 *   POST   /api/sessions/:id/sources           — add a source to a session
 *   DELETE /api/sessions/:id/sources/:sourceId — remove a source from a session
 */

import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { SessionPort } from '../ports/session-port.js';
import { findSessionOrFail, parseBody } from '../route-helpers.js';
import { SessionSourceAddSchema } from '../schemas.js';

export function registerSourceRoutes(app: FastifyInstance, ctx: SessionPort): void {
  app.get('/api/sessions/:id/sources', async (req) => {
    const { id } = req.params as { id: string };
    const session = findSessionOrFail(ctx, id);
    return { success: true, data: { sources: session.sources } };
  });

  app.post('/api/sessions/:id/sources', async (req) => {
    const { id } = req.params as { id: string };
    const session = findSessionOrFail(ctx, id);
    const body = parseBody(SessionSourceAddSchema, req.body);

    const source = {
      id: randomUUID(),
      sessionId: id,
      addedAt: Date.now(),
      ...body,
    };

    session.addSource(source);
    ctx.persistSessionState(session);

    return { success: true, data: { source } };
  });

  app.delete('/api/sessions/:id/sources/:sourceId', async (req) => {
    const { id, sourceId } = req.params as { id: string; sourceId: string };
    const session = findSessionOrFail(ctx, id);
    session.removeSource(sourceId);
    ctx.persistSessionState(session);
    return { success: true };
  });
}
