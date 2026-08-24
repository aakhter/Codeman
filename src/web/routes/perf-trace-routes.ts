import type { FastifyInstance } from 'fastify';
import type { MobileInputTraceCollector } from '../../perf/mobile-input-trace.js';

const TRACE_ROUTE = '/__test/perf/mobile-input';

export function registerPerfTraceRoutes(app: FastifyInstance, trace: MobileInputTraceCollector): void {
  if (!trace.enabled) return;

  app.get<{ Querystring: { clear?: string } }>(TRACE_ROUTE, (request, reply) => {
    reply.header('cache-control', 'no-store').header('vary', 'x-codeman-test-trace-secret');
    const header = request.headers['x-codeman-test-trace-secret'];
    const candidate = typeof header === 'string' ? header : undefined;
    if (!trace.isAuthorized(candidate)) return reply.code(404).send();

    const snapshot = trace.snapshot();
    if (request.query.clear === '1') trace.clear();
    return reply.send(snapshot);
  });
}
