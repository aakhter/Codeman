/**
 * Shared utilities for route testing.
 *
 * Creates minimal Fastify instances with just the route module under test
 * and a mock context. Uses app.inject() for HTTP testing without real ports.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { createMockRouteContext, type MockRouteContext } from '../mocks/index.js';
import { installRouteErrorHandler } from '../../src/web/route-error-handler.js';

export interface RouteTestHarness {
  app: FastifyInstance;
  ctx: MockRouteContext;
}

/**
 * Creates a Fastify instance with a route module registered against a mock context.
 *
 * @param registerFn - The route registration function (e.g., registerSessionRoutes).
 *   Uses `any` for ctx parameter because route functions expect typed port intersections
 *   that MockRouteContext satisfies structurally but not nominally.
 * @param ctxOptions - Optional overrides for the mock context
 */
export async function createRouteTestHarness(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerFn: (app: FastifyInstance, ctx: any) => void,
  ctxOptions?: { sessionId?: string }
): Promise<RouteTestHarness> {
  const app = Fastify({ logger: false });

  // Register cookie plugin — some routes access req.cookies
  await app.register(fastifyCookie);

  const ctx = createMockRouteContext(ctxOptions);

  registerFn(app, ctx);
  // Mirror production: structured errors thrown by route helpers (findSessionOrFail,
  // parseBody) are rendered to {success:false} bodies at the right status.
  installRouteErrorHandler(app);
  await app.ready();

  return { app, ctx };
}
