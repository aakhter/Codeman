import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import WebSocket from 'ws';
import { Session, setMobileInputTraceCollectorForTests } from '../src/session.js';
import { createMobileInputTraceCollector, hashMobileInputTraceValue } from '../src/perf/mobile-input-trace.js';
import { registerWsRoutes } from '../src/web/routes/ws-routes.js';

type InteractiveSessionInternals = {
  _mux: { backend: string; setAttached: (id: string, attached: boolean) => void } | null;
  _useMux: boolean;
  _setupOrAttachMuxSession: () => Promise<{ isRestored: boolean }>;
  ptyProcess: {
    pid: number;
    resize: (cols: number, rows: number) => void;
    write: (data: string) => void;
    kill: () => void;
    onData: (callback: (data: string) => void) => void;
    onExit: (callback: (event: { exitCode: number }) => void) => void;
  } | null;
};

function nextMessage(ws: WebSocket, timeoutMs = 2000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WS message timeout')), timeoutMs);
    ws.once('message', (raw) => {
      clearTimeout(timer);
      resolve(JSON.parse(String(raw)));
    });
  });
}

function installFakeInteractivePty(
  session: Session,
  setupGate: Promise<void> = Promise.resolve()
): {
  start(): Promise<void>;
  emitData(data: string): void;
  exit(): void;
} {
  let onData: ((data: string) => void) | null = null;
  let onExit: ((event: { exitCode: number }) => void) | null = null;
  const internals = session as unknown as InteractiveSessionInternals;
  internals._mux = { backend: 'test', setAttached: vi.fn() };
  internals._useMux = true;
  internals._setupOrAttachMuxSession = vi.fn(async () => {
    await setupGate;
    internals.ptyProcess = {
      pid: 374,
      resize: vi.fn(),
      write: vi.fn(),
      kill: vi.fn(),
      onData: vi.fn((callback) => {
        onData = callback;
      }),
      onExit: vi.fn((callback) => {
        onExit = callback;
      }),
    };
    return { isRestored: true };
  });

  return {
    start: () => session.startInteractive(),
    emitData(data) {
      if (!onData) throw new Error('Interactive PTY data handler was not registered');
      onData(data);
    },
    exit() {
      if (!onExit) throw new Error('Interactive PTY exit handler was not registered');
      onExit({ exitCode: 0 });
    },
  };
}

async function startWithFakeInteractivePty(session: Session): Promise<ReturnType<typeof installFakeInteractivePty>> {
  const fakePty = installFakeInteractivePty(session);
  await fakePty.start();
  return fakePty;
}

describe('COD-374 Session terminal trace', () => {
  const cleanups: Array<() => void | Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) await cleanups.pop()?.();
  });

  it('records the complete interactive PTY through WebSocket output boundary order', async () => {
    const trace = createMobileInputTraceCollector({
      nodeEnv: 'test',
      traceFlag: '1',
      secret: 'session-test-secret',
      capacity: 32,
    });
    const restoreTrace = setMobileInputTraceCollectorForTests(trace);
    cleanups.push(restoreTrace);
    // COD-374 traces the interactive OpenCode PTY only; shell and one-shot paths are intentionally out of scope.
    const session = new Session({ id: 'trace-session', workingDir: '/tmp', mode: 'opencode' });
    const fakePty = await startWithFakeInteractivePty(session);
    cleanups.push(() => fakePty.exit());

    const app = Fastify({ logger: false });
    await app.register(fastifyWebsocket);
    registerWsRoutes(
      app,
      { sessions: new Map([[session.id, session]]) } as never,
      () => ({ bindHost: '127.0.0.1', allowedHosts: [], tunnelHost: null }),
      trace
    );
    await app.listen({ port: 0, host: '127.0.0.1' });
    cleanups.push(() => app.close());
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
    const ws = new WebSocket(`ws://127.0.0.1:${address.port}/ws/sessions/${session.id}/terminal`);
    cleanups.push(() => ws.close());
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });

    const message = nextMessage(ws);
    fakePty.emitData('\x1b[32mharmless output\x1b[0m');
    expect(await message).toMatchObject({ t: 'o' });

    const events = trace.snapshot().events.filter((event) => event.stage.startsWith('server.output.'));
    expect(events.map((event) => event.stage)).toEqual([
      'server.output.pty-received',
      'server.output.handler-enter',
      'server.output.terminal-emitted',
      'server.output.ws-received',
      'server.output.batch-enqueued',
      'server.output.flush-start',
      'server.output.pre-send',
      'server.output.post-send',
    ]);
    expect(events.every((event) => event.sessionHash === events[0].sessionHash)).toBe(true);
    expect(events.every((event) => event.bytes === Buffer.byteLength('\x1b[32mharmless output\x1b[0m'))).toBe(true);
    expect(events.every((event) => event.valueHash?.match(/^[0-9a-f]{16}$/))).toBe(true);
    expect(JSON.stringify(trace.snapshot())).not.toContain('harmless output');

    const sessionOrdinals = events.slice(0, 3).map((event) => event.ordinal);
    const routeOrdinals = events.slice(3).map((event) => event.ordinal);
    expect(sessionOrdinals).toEqual([1, 2, 3]);
    expect(routeOrdinals).toEqual([1, 2, 3, 4, 5]);
  });

  it('restores the Session test observer and rejects a disabled replacement', async () => {
    const enabled = createMobileInputTraceCollector({
      nodeEnv: 'test',
      traceFlag: '1',
      secret: 'enabled',
      capacity: 8,
    });
    const disabled = createMobileInputTraceCollector({ nodeEnv: 'production' });
    const restore = setMobileInputTraceCollectorForTests(enabled);
    cleanups.push(restore);
    const session = new Session({ id: 'restore-session', workingDir: '/tmp', mode: 'opencode' });
    const fakePty = await startWithFakeInteractivePty(session);
    cleanups.push(() => fakePty.exit());

    fakePty.emitData('first secret');
    expect(enabled.snapshot().events.map((event) => event.stage)).toEqual([
      'server.output.pty-received',
      'server.output.handler-enter',
      'server.output.terminal-emitted',
    ]);
    restore();
    fakePty.emitData('second secret');
    expect(enabled.snapshot().events).toHaveLength(3);
    expect(() => setMobileInputTraceCollectorForTests(disabled)).toThrow(/enabled test trace collector/i);
  });

  it('restores nested Session trace collectors by exact token in any order', async () => {
    const first = createMobileInputTraceCollector({
      nodeEnv: 'test',
      traceFlag: '1',
      secret: 'first',
      capacity: 16,
    });
    const second = createMobileInputTraceCollector({
      nodeEnv: 'test',
      traceFlag: '1',
      secret: 'second',
      capacity: 16,
    });
    const restoreFirst = setMobileInputTraceCollectorForTests(first);
    cleanups.push(restoreFirst);
    const restoreSecond = setMobileInputTraceCollectorForTests(second);
    cleanups.push(restoreSecond);
    const session = new Session({ id: 'nested-restore-session', workingDir: '/tmp', mode: 'opencode' });
    const fakePty = await startWithFakeInteractivePty(session);
    cleanups.push(() => fakePty.exit());

    fakePty.emitData('second active');
    expect(first.snapshot().events).toHaveLength(0);
    expect(second.snapshot().events).toHaveLength(3);

    restoreFirst();
    restoreFirst();
    fakePty.emitData('second remains active');
    expect(first.snapshot().events).toHaveLength(0);
    expect(second.snapshot().events).toHaveLength(6);

    restoreSecond();
    fakePty.emitData('global collector restored');
    expect(first.snapshot().events).toHaveLength(0);
    expect(second.snapshot().events).toHaveLength(6);
  });

  it('binds each overlapping interactive Session to the collector active at handler installation', async () => {
    const first = createMobileInputTraceCollector({
      nodeEnv: 'test',
      traceFlag: '1',
      secret: 'concurrent-first',
      capacity: 32,
    });
    const second = createMobileInputTraceCollector({
      nodeEnv: 'test',
      traceFlag: '1',
      secret: 'concurrent-second',
      capacity: 32,
    });

    const restoreFirst = setMobileInputTraceCollectorForTests(first);
    cleanups.push(restoreFirst);
    const sessionA = new Session({ id: 'concurrent-session-a', workingDir: '/tmp', mode: 'opencode' });
    const fakePtyA = await startWithFakeInteractivePty(sessionA);
    cleanups.push(() => fakePtyA.exit());

    const restoreSecond = setMobileInputTraceCollectorForTests(second);
    cleanups.push(restoreSecond);
    const sessionB = new Session({ id: 'concurrent-session-b', workingDir: '/tmp', mode: 'opencode' });
    const fakePtyB = await startWithFakeInteractivePty(sessionB);
    cleanups.push(() => fakePtyB.exit());

    fakePtyA.emitData('A while B registration is active');
    expect(first.snapshot().events).toHaveLength(3);
    expect(second.snapshot().events).toHaveLength(0);

    restoreFirst();
    restoreFirst();
    fakePtyA.emitData('A after its registration is restored');
    fakePtyB.emitData('B after A registration is restored');
    expect(first.snapshot().events).toHaveLength(3);
    expect(second.snapshot().events).toHaveLength(3);

    restoreSecond();
    restoreSecond();
    fakePtyA.emitData('A after both registrations are restored');
    fakePtyB.emitData('B after both registrations are restored');
    expect(first.snapshot().events).toHaveLength(3);
    expect(second.snapshot().events).toHaveLength(3);
    expect(first.snapshot().events.every((event) => event.sessionHash === hashMobileInputTraceValue(sessionA.id))).toBe(
      true
    );
    expect(
      second.snapshot().events.every((event) => event.sessionHash === hashMobileInputTraceValue(sessionB.id))
    ).toBe(true);
  });

  it('binds collector A synchronously before concurrent interactive mux setup yields to B', async () => {
    const first = createMobileInputTraceCollector({
      nodeEnv: 'test',
      traceFlag: '1',
      secret: 'concurrent-start-first',
      capacity: 16,
    });
    const second = createMobileInputTraceCollector({
      nodeEnv: 'test',
      traceFlag: '1',
      secret: 'concurrent-start-second',
      capacity: 16,
    });
    let releaseA!: () => void;
    const setupGateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });

    const restoreFirst = setMobileInputTraceCollectorForTests(first);
    cleanups.push(restoreFirst);
    const sessionA = new Session({ id: 'concurrent-start-a', workingDir: '/tmp', mode: 'opencode' });
    const fakePtyA = installFakeInteractivePty(sessionA, setupGateA);
    const startingA = fakePtyA.start();

    const restoreSecond = setMobileInputTraceCollectorForTests(second);
    cleanups.push(restoreSecond);
    const sessionB = new Session({ id: 'concurrent-start-b', workingDir: '/tmp', mode: 'opencode' });
    const fakePtyB = installFakeInteractivePty(sessionB);
    const startingB = fakePtyB.start();

    releaseA();
    await Promise.all([startingA, startingB]);
    cleanups.push(() => fakePtyA.exit());
    cleanups.push(() => fakePtyB.exit());

    fakePtyA.emitData('A after overlapping start');
    fakePtyB.emitData('B after overlapping start');

    expect(first.snapshot().events).toHaveLength(3);
    expect(second.snapshot().events).toHaveLength(3);
    expect(first.snapshot().events.every((event) => event.sessionHash === hashMobileInputTraceValue(sessionA.id))).toBe(
      true
    );
    expect(
      second.snapshot().events.every((event) => event.sessionHash === hashMobileInputTraceValue(sessionB.id))
    ).toBe(true);
  });

  it('does not enter the Session trace recorder when the global collector is disabled', async () => {
    const session = new Session({ id: 'disabled-session-trace', workingDir: '/tmp', mode: 'opencode' });
    const internals = session as unknown as {
      _recordMobileInputOutputTrace(...args: unknown[]): void;
    };
    const recorder = vi.spyOn(internals, '_recordMobileInputOutputTrace').mockImplementation(() => {
      throw new Error('disabled Session trace recorder was entered');
    });
    const fakePty = await startWithFakeInteractivePty(session);
    cleanups.push(() => fakePty.exit());

    fakePty.emitData('disabled output');

    expect(recorder).not.toHaveBeenCalled();
  });

  it('does not trace the shared shell output path', () => {
    const trace = createMobileInputTraceCollector({
      nodeEnv: 'test',
      traceFlag: '1',
      secret: 'shell-out-of-scope',
      capacity: 8,
    });
    const restore = setMobileInputTraceCollectorForTests(trace);
    cleanups.push(restore);
    const shell = new Session({ id: 'shell-out-of-scope', workingDir: '/tmp', mode: 'shell' });
    const handleOutput = (shell as unknown as { _handleTerminalOutput(data: string): void })._handleTerminalOutput.bind(
      shell
    );

    handleOutput('shell output');

    expect(trace.snapshot().events).toEqual([]);
  });
});
