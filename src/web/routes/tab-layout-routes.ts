/** @fileoverview Authenticated owner-scoped tab-layout read/write API. */
import type { FastifyInstance } from 'fastify';
import { ownerLayoutKey } from '../../tab-layout-persistence.js';
import { TabLayoutValidationError } from '../../tab-layout.js';
import { ApiErrorCode, createErrorResponse } from '../../types.js';
import { ownerFor } from '../route-helpers.js';
import type { TabLayoutPort } from '../ports/index.js';

export const TAB_LAYOUT_BODY_LIMIT = 128 * 1024;

function parseWriteBody(
  body: unknown
):
  | { kind: 'layout'; baseVersion: number; layout: unknown }
  | { kind: 'operations'; baseVersion: number; operations: unknown; recoveryBaseLayout?: unknown } {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new TabLayoutValidationError('body must be an object');
  }
  const input = body as {
    baseVersion?: unknown;
    layout?: unknown;
    operations?: unknown;
    recoveryBaseLayout?: unknown;
  };
  if (!Number.isSafeInteger(input.baseVersion) || (input.baseVersion as number) < 0) {
    throw new TabLayoutValidationError('baseVersion must be a non-negative safe integer');
  }
  if ('operations' in input && input.layout === undefined) {
    return {
      kind: 'operations',
      baseVersion: input.baseVersion as number,
      operations: input.operations,
      ...(input.recoveryBaseLayout === undefined ? {} : { recoveryBaseLayout: input.recoveryBaseLayout }),
    };
  }
  if (input.layout !== undefined && input.operations === undefined) {
    return { kind: 'layout', baseVersion: input.baseVersion as number, layout: input.layout };
  }
  throw new TabLayoutValidationError('exactly one of layout or operations is required');
}

export function registerTabLayoutRoutes(app: FastifyInstance, ctx: TabLayoutPort): void {
  app.get('/api/tab-layout', async (req) => {
    const owner = ownerLayoutKey(ownerFor(req));
    const snapshot = await ctx.tabLayouts.getSnapshot(owner);
    return { success: true, data: snapshot };
  });

  app.put('/api/tab-layout', { bodyLimit: TAB_LAYOUT_BODY_LIMIT }, async (req, reply) => {
    try {
      const parsed = parseWriteBody(req.body);
      const owner = ownerLayoutKey(ownerFor(req));
      const result =
        parsed.kind === 'operations'
          ? parsed.recoveryBaseLayout === undefined
            ? await ctx.tabLayouts.putOperations(owner, parsed.operations as never, parsed.baseVersion)
            : await ctx.tabLayouts.putOperations(
                owner,
                parsed.operations as never,
                parsed.baseVersion,
                parsed.recoveryBaseLayout
              )
          : await ctx.tabLayouts.put(owner, parsed.layout, parsed.baseVersion);
      if (result.status === 'conflict') {
        return reply.code(409).send({
          ...createErrorResponse(ApiErrorCode.CONFLICT, 'Tab layout version conflict'),
          data: {
            layout: result.layout,
            ...('placements' in result ? { placements: result.placements } : {}),
            ...('appliedOperationCount' in result ? { appliedOperationCount: result.appliedOperationCount } : {}),
          },
        });
      }
      return {
        success: true,
        data: { layout: result.layout, ...('placements' in result ? { placements: result.placements } : {}) },
      };
    } catch (error) {
      if (error instanceof TabLayoutValidationError) {
        return reply.code(400).send(createErrorResponse(ApiErrorCode.INVALID_INPUT, error.message));
      }
      throw error;
    }
  });
}
