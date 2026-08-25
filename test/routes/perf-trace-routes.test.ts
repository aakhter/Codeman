import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { createMobileInputTraceCollector } from '../../src/perf/mobile-input-trace.js';
import { registerPerfTraceRoutes } from '../../src/web/routes/perf-trace-routes.js';

describe('COD-374 test-only performance trace route', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
  });

  it.each([
    { nodeEnv: 'test', traceFlag: undefined, secret: 'exact-secret' },
    { nodeEnv: 'test', traceFlag: 'true', secret: 'exact-secret' },
    { nodeEnv: 'test', traceFlag: '1', secret: '' },
    { nodeEnv: 'development', traceFlag: '1', secret: 'exact-secret' },
    { nodeEnv: 'production', traceFlag: '1', secret: 'exact-secret' },
  ])('does not register the retrieval route for a normal $nodeEnv server', async (config) => {
    app = Fastify({ logger: false });
    const trace = createMobileInputTraceCollector({ ...config, capacity: 8 });

    registerPerfTraceRoutes(app, trace);
    await app.ready();

    expect(app.hasRoute({ method: 'GET', url: '/__test/perf/mobile-input' })).toBe(false);
    expect((await app.inject({ method: 'GET', url: '/__test/perf/mobile-input' })).statusCode).toBe(404);
  });

  it.each([undefined, '', 'wrong-secret', 'exact-secret-extra'])(
    'returns 404 for a non-exact secret: %s',
    async (secret) => {
      app = Fastify({ logger: false });
      const trace = createMobileInputTraceCollector({
        nodeEnv: 'test',
        traceFlag: '1',
        secret: 'exact-secret',
        capacity: 8,
      });
      trace.record({ stage: 'server.input.received', monoNs: '1', clientId: 'client-1', seq: 1 });
      registerPerfTraceRoutes(app, trace);
      await app.ready();

      const response = await app.inject({
        method: 'GET',
        url: '/__test/perf/mobile-input?clear=1',
        headers: secret === undefined ? {} : { 'x-codeman-test-trace-secret': secret },
      });

      expect(response.statusCode).toBe(404);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers.vary).toBe('x-codeman-test-trace-secret');
      expect(trace.snapshot().events).toHaveLength(1);
    }
  );

  it('returns an authenticated snapshot without clearing by default', async () => {
    app = Fastify({ logger: false });
    const trace = createMobileInputTraceCollector({
      nodeEnv: 'test',
      traceFlag: '1',
      secret: 'exact-secret',
      capacity: 8,
    });
    trace.record({ stage: 'server.input.received', monoNs: '1', clientId: 'client-1', seq: 1 });
    registerPerfTraceRoutes(app, trace);
    await app.ready();

    const response = await app.inject({
      method: 'GET',
      url: '/__test/perf/mobile-input',
      headers: { 'x-codeman-test-trace-secret': 'exact-secret' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers.vary).toBe('x-codeman-test-trace-secret');
    expect(response.json()).toEqual({
      enabled: true,
      overflowed: false,
      events: [{ stage: 'server.input.received', monoNs: '1', clientId: 'client-1', seq: 1 }],
    });
    expect(trace.snapshot().events).toHaveLength(1);
  });

  it('returns the authenticated snapshot before clearing events and overflow state', async () => {
    app = Fastify({ logger: false });
    const trace = createMobileInputTraceCollector({
      nodeEnv: 'test',
      traceFlag: '1',
      secret: 'exact-secret',
      capacity: 1,
    });
    trace.record({ stage: 'server.input.received', monoNs: '1', clientId: 'client-1', seq: 1 });
    trace.record({ stage: 'server.input.pre-write', monoNs: '2', clientId: 'client-1', seq: 1 });
    registerPerfTraceRoutes(app, trace);
    await app.ready();

    const response = await app.inject({
      method: 'GET',
      url: '/__test/perf/mobile-input?clear=1',
      headers: { 'x-codeman-test-trace-secret': 'exact-secret' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers.vary).toBe('x-codeman-test-trace-secret');
    expect(response.json()).toMatchObject({ enabled: true, overflowed: true });
    expect(response.json().events).toHaveLength(1);
    expect(trace.snapshot()).toEqual({ enabled: true, overflowed: false, events: [] });
  });

  it('does not clear for values other than the exact clear flag', async () => {
    app = Fastify({ logger: false });
    const trace = createMobileInputTraceCollector({
      nodeEnv: 'test',
      traceFlag: '1',
      secret: 'exact-secret',
      capacity: 8,
    });
    trace.record({ stage: 'server.input.received', monoNs: '1' });
    registerPerfTraceRoutes(app, trace);
    await app.ready();

    const response = await app.inject({
      method: 'GET',
      url: '/__test/perf/mobile-input?clear=true',
      headers: { 'x-codeman-test-trace-secret': 'exact-secret' },
    });

    expect(response.statusCode).toBe(200);
    expect(trace.snapshot().events).toHaveLength(1);
  });
});
