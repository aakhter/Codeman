/**
 * @fileoverview Library routes for COD-63 knowledge-base feature.
 *
 * Endpoints:
 *   GET /api/library?q=&tag=&limit=   — cross-session document index with optional
 *                                       text search and tag filtering.
 */

import type { FastifyInstance } from 'fastify';
import type { SessionPort } from '../ports/session-port.js';
import { parseBody } from '../route-helpers.js';
import { LibraryQuerySchema } from '../schemas.js';
import { harvestDocuments, queryDocuments } from '../../library-index.js';
import type { LibraryQueryResult } from '../../types/library.js';

export function registerLibraryRoutes(app: FastifyInstance, ctx: SessionPort): void {
  app.get('/api/library', async (req) => {
    const { q, tag, limit } = parseBody(LibraryQuerySchema, req.query);

    const documents = harvestDocuments(ctx.sessions as never);
    const results = queryDocuments(documents, q, tag, limit ?? 50);

    const data: LibraryQueryResult = {
      documents: results,
      total: results.length,
    };

    return { success: true, data };
  });
}
