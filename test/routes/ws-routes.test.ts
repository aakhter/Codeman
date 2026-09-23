/**
 * @fileoverview Tests for WebSocket terminal I/O route.
 *
 * Unlike other route tests that use app.inject(), WebSocket testing requires
 * a real listening server since inject() doesn't support upgrade requests.
 * Uses the `ws` package (transitive dep of @fastify/websocket) as the client.
 *
 * @dependency test/mocks/mock-route-context.ts (createMockRouteContext)
 * @dependency src/web/routes/ws-routes.ts (registerWsRoutes)
 * Port: 3170 (ws-routes tests)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const terminalClassifierState = vi.hoisted(() => ({ throwFor: null as string | null }));
const traceTimingState = vi.hoisted(() => ({
  active: false,
  clock: 0n,
  metadataTimes: [] as bigint[],
  marker: 'COD-374 timing boundary',
  throwHelpers: false,
}));

vi.mock('../../src/terminal-input-classifier.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/terminal-input-classifier.js')>();
  return {
    ...actual,
    isKeyboardTerminalInput(input: string) {
      if (input === terminalClassifierState.throwFor) throw new Error('classifier failed');
      return actual.isKeyboardTerminalInput(input);
    },
  };
});

vi.mock('../../src/perf/mobile-input-trace.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/perf/mobile-input-trace.js')>();
  return {
    ...actual,
    mobileInputTraceTimestamp() {
      if (traceTimingState.throwHelpers) throw new Error('disabled trace evaluated timestamp helper');
      if (!traceTimingState.active) return actual.mobileInputTraceTimestamp();
      traceTimingState.clock += 1n;
      return { monoNs: String(traceTimingState.clock), epochMs: Number(traceTimingState.clock) };
    },
    hashMobileInputTraceValue(value: string | Uint8Array) {
      if (traceTimingState.throwHelpers) throw new Error('disabled trace evaluated hash helper');
      if (traceTimingState.active && value === traceTimingState.marker) {
        traceTimingState.clock += 1n;
        traceTimingState.metadataTimes.push(traceTimingState.clock);
      }
      return actual.hashMobileInputTraceValue(value);
    },
  };
});

import Fastify, { type FastifyInstance } from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import WebSocket from 'ws';
import { createMockRouteContext, type MockRouteContext } from '../mocks/index.js';
import { registerWsRoutes } from '../../src/web/routes/ws-routes.js';
import { MAX_INPUT_LENGTH } from '../../src/config/terminal-limits.js';
import { createMobileInputTraceCollector, type MobileInputTraceCollector } from '../../src/perf/mobile-input-trace.js';

const PORT = 3170;

/** Helper: open a WebSocket connection and wait for it to reach OPEN state. */
function connectWs(path: string, timeoutMs = 5000): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WS connection timeout')), timeoutMs);
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}${path}`);
    ws.on('open', () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/** Helper: wait for the next WS message, parsed as JSON. */
function nextMessage(ws: WebSocket, timeoutMs = 2000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WS message timeout')), timeoutMs);
    ws.once('message', (raw) => {
      clearTimeout(timer);
      resolve(JSON.parse(String(raw)));
    });
  });
}

/** Helper: wait for WS close event and return { code, reason }. */
function waitForClose(ws: WebSocket, timeoutMs = 2000): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WS close timeout')), timeoutMs);
    ws.on('close', (code, reason) => {
      clearTimeout(timer);
      resolve({ code, reason: reason.toString() });
    });
  });
}

/** Helper: collect N messages from a WebSocket. */
function collectMessages(ws: WebSocket, count: number, timeoutMs = 3000): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Only received ${msgs.length}/${count} messages`)), timeoutMs);
    const msgs: unknown[] = [];
    const onMessage = (raw: WebSocket.RawData) => {
      msgs.push(JSON.parse(String(raw)));
      if (msgs.length >= count) {
        clearTimeout(timer);
        ws.off('message', onMessage);
        resolve(msgs);
      }
    };
    ws.on('message', onMessage);
  });
}

describe('ws-routes', () => {
  let app: FastifyInstance;
  let ctx: MockRouteContext;
  let trace: MobileInputTraceCollector;
  let sizingSession: MockRouteContext['_session'] & {
    activateTerminalViewer: ReturnType<typeof vi.fn>;
    resizeFromTerminalViewer: ReturnType<typeof vi.fn>;
    bootstrapTerminalViewer: ReturnType<typeof vi.fn>;
    releaseTerminalViewer: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    app = Fastify({ logger: false });
    await app.register(fastifyWebsocket);

    ctx = createMockRouteContext({ sessionId: 'ws-test-session' });
    trace = createMobileInputTraceCollector({
      nodeEnv: 'test',
      traceFlag: '1',
      secret: 'route-test-secret',
      capacity: 512,
    });
    sizingSession = Object.assign(ctx._session, {
      activateTerminalViewer: vi.fn(),
      resizeFromTerminalViewer: vi.fn(() => false),
      bootstrapTerminalViewer: vi.fn(() => true),
      releaseTerminalViewer: vi.fn(),
    });
    registerWsRoutes(app, ctx as never, () => ({ bindHost: '127.0.0.1', allowedHosts: [], tunnelHost: null }), trace);

    await app.listen({ port: PORT, host: '127.0.0.1' });
  });

  afterEach(async () => {
    terminalClassifierState.throwFor = null;
    traceTimingState.active = false;
    traceTimingState.clock = 0n;
    traceTimingState.metadataTimes = [];
    traceTimingState.throwHelpers = false;
    await app.close();
  });

  // ========== Session not found ==========

  describe('session not found', () => {
    it('closes with 4004 when session does not exist', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/sessions/nonexistent/terminal`);
      const { code, reason } = await waitForClose(ws);
      expect(code).toBe(4004);
      expect(reason).toBe('Session not found');
    });
  });

  // ========== Terminal output ==========

  describe('terminal output', () => {
    it('COD-374 distinguishes identical output stages for two viewer connections', async () => {
      const first = await connectWs('/ws/sessions/ws-test-session/terminal?cid=viewer-one');
      const second = await connectWs('/ws/sessions/ws-test-session/terminal?cid=viewer-two');
      try {
        const messages = [nextMessage(first), nextMessage(second)];
        ctx._session.emit('terminal', 'shared output');
        await Promise.all(messages);

        const outputEvents = trace.snapshot().events.filter((event) => event.stage.startsWith('server.output.'));
        const connectionHashes = [...new Set(outputEvents.map((event) => event.connectionHash))];
        expect(connectionHashes).toHaveLength(2);
        expect(connectionHashes.every((hash) => hash?.match(/^[0-9a-f]{16}$/))).toBe(true);
        for (const connectionHash of connectionHashes) {
          const connectionEvents = outputEvents.filter((event) => event.connectionHash === connectionHash);
          expect(connectionEvents.map((event) => event.ordinal)).toEqual([1, 2, 3, 4, 5]);
          expect(connectionEvents.map((event) => event.stage)).toEqual([
            'server.output.ws-received',
            'server.output.batch-enqueued',
            'server.output.flush-start',
            'server.output.pre-send',
            'server.output.post-send',
          ]);
        }
      } finally {
        first.close();
        second.close();
      }
    });

    it('COD-374 timestamps WebSocket receipt and flush entry before output metadata work', async () => {
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        traceTimingState.active = true;
        const message = nextMessage(ws);
        ctx._session.emit('terminal', traceTimingState.marker);
        await message;

        const events = trace.snapshot().events;
        const wsReceived = events.find((event) => event.stage === 'server.output.ws-received');
        const flushStart = events.find((event) => event.stage === 'server.output.flush-start');
        expect(traceTimingState.metadataTimes).toHaveLength(2);
        expect(BigInt(wsReceived?.monoNs ?? 0)).toBeLessThan(traceTimingState.metadataTimes[0]);
        expect(BigInt(flushStart?.monoNs ?? 0)).toBeLessThan(traceTimingState.metadataTimes[1]);
      } finally {
        ws.close();
      }
    });

    it('COD-374 traces WebSocket output batching and send boundaries without raw terminal text', async () => {
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        ctx._session.emit('terminal', 'sensitive ');
        ctx._session.emit('terminal', 'terminal output');

        expect(await nextMessage(ws)).toMatchObject({ t: 'o' });
        const events = trace.snapshot().events.filter((event) => event.stage.startsWith('server.output.'));

        expect(events.map((event) => event.stage)).toEqual([
          'server.output.ws-received',
          'server.output.batch-enqueued',
          'server.output.ws-received',
          'server.output.batch-enqueued',
          'server.output.flush-start',
          'server.output.pre-send',
          'server.output.post-send',
        ]);
        expect(events.map((event) => event.ordinal)).toEqual([1, 2, 3, 4, 5, 6, 7]);
        expect(events.map((event) => event.bytes)).toEqual([
          Buffer.byteLength('sensitive '),
          Buffer.byteLength('sensitive '),
          Buffer.byteLength('terminal output'),
          Buffer.byteLength('terminal output'),
          Buffer.byteLength('sensitive terminal output'),
          Buffer.byteLength('sensitive terminal output'),
          Buffer.byteLength('sensitive terminal output'),
        ]);
        expect(events.every((event) => event.valueHash?.match(/^[0-9a-f]{16}$/))).toBe(true);
        expect(events.at(-1)).toMatchObject({ stage: 'server.output.post-send', delivered: true });
        expect(events.slice(0, -1).every((event) => event.delivered === undefined)).toBe(true);
        expect(JSON.stringify(trace.snapshot())).not.toContain('sensitive terminal output');
      } finally {
        ws.close();
      }
    });

    it('COD-374 never records failed WebSocket output as delivered', async () => {
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      const serverSocket = [
        ...(app as FastifyInstance & { websocketServer: { clients: Set<WebSocket> } }).websocketServer.clients,
      ][0];
      const send = vi.spyOn(serverSocket, 'send').mockImplementationOnce(() => {
        throw new Error('injected output send failure');
      });
      try {
        expect(() => ctx._session.emit('terminal', 'x'.repeat(16_385))).toThrow(/injected output send failure/);
        const outputEvents = trace.snapshot().events.filter((event) => event.stage.startsWith('server.output.'));
        expect(outputEvents.at(-1)).toMatchObject({ stage: 'server.output.pre-send' });
        expect(outputEvents).not.toContainEqual(
          expect.objectContaining({ stage: 'server.output.post-send', delivered: true })
        );
      } finally {
        send.mockRestore();
        ws.close();
      }
    });

    it('receives terminal output via WS with DEC 2026 sync markers', async () => {
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        const session = ctx._session;

        // Emit terminal data from mock session
        session.emit('terminal', 'hello world');

        // Wait for the micro-batched message (8ms batch interval + margin)
        const msg = (await nextMessage(ws)) as { t: string; d: string };
        expect(msg.t).toBe('o');
        // Should contain DEC 2026 sync markers wrapping the data
        expect(msg.d).toContain('hello world');
        expect(msg.d).toMatch(/^\x1b\[\?2026h/); // starts with DEC 2026 start
        expect(msg.d).toMatch(/\x1b\[\?2026l$/); // ends with DEC 2026 end
      } finally {
        ws.close();
      }
    });

    it('sends clearTerminal event as {"t":"c"}', async () => {
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        ctx._session.emit('clearTerminal');

        const msg = (await nextMessage(ws)) as { t: string };
        expect(msg.t).toBe('c');
      } finally {
        ws.close();
      }
    });

    it('sends needsRefresh event as {"t":"r"}', async () => {
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        ctx._session.emit('needsRefresh');

        const msg = (await nextMessage(ws)) as { t: string };
        expect(msg.t).toBe('r');
      } finally {
        ws.close();
      }
    });

    it('coalesces rapid terminal emissions into a single frame', async () => {
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        const session = ctx._session;

        // Emit multiple small chunks in rapid succession (within the 8ms batch window)
        session.emit('terminal', 'chunk1');
        session.emit('terminal', 'chunk2');
        session.emit('terminal', 'chunk3');

        // Should arrive as a single coalesced message
        const msg = (await nextMessage(ws)) as { t: string; d: string };
        expect(msg.t).toBe('o');
        expect(msg.d).toContain('chunk1chunk2chunk3');
      } finally {
        ws.close();
      }
    });

    it('flushes immediately when batch exceeds size threshold', async () => {
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        const session = ctx._session;

        // Emit data larger than WS_BATCH_FLUSH_THRESHOLD (16384)
        const largeData = 'X'.repeat(17000);
        session.emit('terminal', largeData);

        // Should flush immediately (no 8ms wait) — use a tight timeout
        const msg = (await nextMessage(ws, 500)) as { t: string; d: string };
        expect(msg.t).toBe('o');
        expect(msg.d).toContain(largeData);
      } finally {
        ws.close();
      }
    });
  });

  // ========== Client input ==========

  describe('client input', () => {
    it('COD-374 records pre-write only after checkpoint handling and immediately at write entry', async () => {
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      const session = ctx._session;
      const originalWrite = session.write.bind(session);
      let stagesAtCheckpoint: string[] = [];
      let stagesAtWrite: string[] = [];
      session.isCheckpointActive = true;
      session.cancelCheckpoint.mockImplementationOnce(() => {
        stagesAtCheckpoint = trace.snapshot().events.map((event) => event.stage);
      });
      const write = vi.spyOn(session, 'write').mockImplementation((data) => {
        stagesAtWrite = trace.snapshot().events.map((event) => event.stage);
        return originalWrite(data);
      });
      try {
        ws.send(JSON.stringify({ t: 'i', d: 'boundary\r', cid: 'boundary-client', seq: 8 }));
        expect(await nextMessage(ws)).toEqual({ t: 'ia', seq: 8 });

        expect(stagesAtCheckpoint).not.toContain('server.input.pre-write');
        expect(stagesAtWrite.at(-1)).toBe('server.input.pre-write');
      } finally {
        write.mockRestore();
        ws.close();
      }
    });

    it('COD-374 does not claim a write boundary when input classification throws', async () => {
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        terminalClassifierState.throwFor = 'classification-failure';
        ws.send(JSON.stringify({ t: 'i', d: terminalClassifierState.throwFor, cid: 'classifier-client', seq: 9 }));

        await expect(nextMessage(ws, 200)).rejects.toThrow(/timeout/);
        const stages = trace
          .snapshot()
          .events.filter((event) => event.clientId === 'classifier-client')
          .map((event) => event.stage);
        expect(stages).not.toContain('server.input.pre-write');
        expect(stages).not.toContain('server.input.post-write');
        expect(ctx._session.shouldApplyInput('classifier-client', 9)).toBe(true);
      } finally {
        ws.close();
      }
    });

    it('COD-374 traces exact tagged input stages in write and ACK order', async () => {
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        ws.send(JSON.stringify({ t: 'i', d: 'trace-me\r', cid: 'client-1', seq: 7 }));

        expect(await nextMessage(ws)).toEqual({ t: 'ia', seq: 7 });
        const events = trace.snapshot().events.filter((event) => event.clientId === 'client-1' && event.seq === 7);
        expect(events.map((event) => event.stage)).toEqual([
          'server.input.received',
          'server.input.parsed',
          'server.input.deduped',
          'server.input.activated',
          'server.input.pre-write',
          'server.input.post-write',
          'server.input.pre-ack',
          'server.input.post-ack',
        ]);
        expect(events.map((event) => event.ordinal)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
        expect(events.every((event) => event.sessionHash?.match(/^[0-9a-f]{16}$/))).toBe(true);
        expect(JSON.stringify(events)).not.toContain('trace-me');
      } finally {
        ws.close();
      }
    });

    it('COD-374 records duplicates as unapplied, skips a second write, and still ACKs', async () => {
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      const write = vi.spyOn(ctx._session, 'write');
      try {
        const frame = JSON.stringify({ t: 'i', d: 'once\r', cid: 'duplicate-client', seq: 2 });
        ws.send(frame);
        expect(await nextMessage(ws)).toEqual({ t: 'ia', seq: 2 });
        ws.send(frame);
        expect(await nextMessage(ws)).toEqual({ t: 'ia', seq: 2 });

        const deduped = trace
          .snapshot()
          .events.filter((event) => event.stage === 'server.input.deduped' && event.clientId === 'duplicate-client');
        expect(deduped.map((event) => event.applied)).toEqual([true, false]);
        expect(write).toHaveBeenCalledTimes(1);
        expect(
          trace
            .snapshot()
            .events.filter(
              (event) => event.stage === 'server.input.post-write' && event.clientId === 'duplicate-client'
            )
        ).toHaveLength(1);
      } finally {
        write.mockRestore();
        ws.close();
      }
    });

    it('COD-374 records a failed write without ACK and leaves the tagged frame retryable', async () => {
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        ctx._session.failWrites = true;
        ws.send(JSON.stringify({ t: 'i', d: 'retry\r', cid: 'failed-client', seq: 3 }));

        await expect(nextMessage(ws, 200)).rejects.toThrow(/timeout/);
        const events = trace.snapshot().events.filter((event) => event.clientId === 'failed-client');
        expect(events.find((event) => event.stage === 'server.input.post-write')?.delivered).toBe(false);
        expect(events.some((event) => event.stage === 'server.input.pre-ack')).toBe(false);
        expect(ctx._session.shouldApplyInput('failed-client', 3)).toBe(true);
      } finally {
        ws.close();
      }
    });

    it('COD-374 never traces a successful write for malformed or oversized frames', async () => {
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        ws.send('not-json{{{');
        ws.send(JSON.stringify({ t: 'i', d: 'x'.repeat(MAX_INPUT_LENGTH + 1), cid: 'oversized-client', seq: 4 }));
        ws.send(JSON.stringify({ t: 'i', d: 'ok', cid: 'valid-client', seq: 5 }));
        expect(await nextMessage(ws)).toEqual({ t: 'ia', seq: 5 });

        const successfulWrites = trace
          .snapshot()
          .events.filter((event) => event.stage === 'server.input.post-write' && event.delivered === true);
        expect(successfulWrites.map((event) => event.clientId)).toEqual(['valid-client']);
      } finally {
        ws.close();
      }
    });

    it('COD-374 preserves tagged input behavior when tracing is disabled', async () => {
      const disabledApp = Fastify({ logger: false });
      await disabledApp.register(fastifyWebsocket);
      const disabledCtx = createMockRouteContext({ sessionId: 'disabled-trace-session' });
      Object.assign(disabledCtx._session, {
        activateTerminalViewer: vi.fn(),
        resizeFromTerminalViewer: vi.fn(() => false),
        releaseTerminalViewer: vi.fn(),
      });
      let enabledReads = 0;
      const disabledTrace: MobileInputTraceCollector = {
        get enabled() {
          enabledReads += 1;
          if (enabledReads > 1) throw new Error('disabled trace recorder was entered');
          return false;
        },
        record() {
          throw new Error('disabled trace record was called');
        },
        snapshot: () => ({ enabled: false, overflowed: false, events: [] }),
        clear: vi.fn(),
        isAuthorized: () => false,
      };
      registerWsRoutes(
        disabledApp,
        disabledCtx as never,
        () => ({ bindHost: '127.0.0.1', allowedHosts: [], tunnelHost: null }),
        disabledTrace
      );
      await disabledApp.listen({ port: 0, host: '127.0.0.1' });
      const address = disabledApp.server.address();
      if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
      const ws = new WebSocket(`ws://127.0.0.1:${address.port}/ws/sessions/disabled-trace-session/terminal`);
      try {
        await new Promise<void>((resolve, reject) => {
          ws.once('open', resolve);
          ws.once('error', reject);
        });
        traceTimingState.throwHelpers = true;
        const outputMessage = nextMessage(ws);
        disabledCtx._session.emit('terminal', 'disabled output');
        expect(await outputMessage).toMatchObject({ t: 'o' });
        const message = nextMessage(ws);
        ws.send(JSON.stringify({ t: 'i', d: 'unchanged\r', cid: 'disabled-client', seq: 1 }));

        expect(await message).toEqual({ t: 'ia', seq: 1 });
        expect(disabledCtx._session.writeBuffer).toEqual(['unchanged\r']);
        expect(disabledTrace.snapshot().events).toEqual([]);
        expect(enabledReads).toBe(1);
      } finally {
        ws.close();
        await disabledApp.close();
      }
    });

    it('forwards input messages to session.write()', async () => {
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      const info = vi.spyOn(console, 'info').mockImplementation(() => {});
      const session = ctx._session;
      const write = vi.spyOn(session, 'write');
      try {
        session.isCheckpointActive = true;

        ws.send(JSON.stringify({ t: 'i', d: 'ls -la\r' }));

        // Give the message handler time to process
        await vi.waitFor(() => {
          expect(session.writeBuffer).toContain('ls -la\r');
          expect(session.cancelCheckpoint).toHaveBeenCalledWith('manual-takeover');
        });
        expect(info).toHaveBeenCalledWith('[Checkpoint] manual takeover', {
          sessionId: 'ws-test-session',
          route: 'ws',
          inputClass: 'keyboard',
        });
        expect(JSON.stringify(info.mock.calls)).not.toContain('ls -la');
        expect(session.cancelCheckpoint.mock.invocationCallOrder[0]).toBeLessThan(write.mock.invocationCallOrder[0]);
        expect(sizingSession.activateTerminalViewer).toHaveBeenCalledWith(expect.any(Symbol));
        expect(sizingSession.activateTerminalViewer.mock.invocationCallOrder[0]).toBeLessThan(
          write.mock.invocationCallOrder[0]
        );
      } finally {
        write.mockRestore();
        info.mockRestore();
        ws.close();
      }
    });

    it.each(['\x1b[I', '\x1b[<0;10;5M', '\x1b[M !!'])('forwards report-only input without takeover', async (input) => {
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        const session = ctx._session;
        session.isCheckpointActive = true;
        ws.send(JSON.stringify({ t: 'i', d: input }));
        await vi.waitFor(() => expect(session.writeBuffer).toContain(input));
        expect(session.cancelCheckpoint).not.toHaveBeenCalled();
      } finally {
        ws.close();
      }
    });

    it('cancels for mixed report and keyboard input', async () => {
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        const session = ctx._session;
        session.isCheckpointActive = true;
        const input = '\x1b[<0;10;5Mx';
        ws.send(JSON.stringify({ t: 'i', d: input }));
        await vi.waitFor(() => expect(session.writeBuffer).toContain(input));
        expect(session.cancelCheckpoint).toHaveBeenCalledWith('manual-takeover');
      } finally {
        ws.close();
      }
    });

    it('ACKs a delivered input and burns its seq', async () => {
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      const write = vi.spyOn(ctx._session, 'write');
      try {
        const session = ctx._session;
        ws.send(JSON.stringify({ t: 'i', d: 'ok\r', cid: 'c1', seq: 1 }));

        expect(await nextMessage(ws)).toEqual({ t: 'ia', seq: 1 });
        expect(sizingSession.activateTerminalViewer).toHaveBeenCalledTimes(1);
        expect(sizingSession.activateTerminalViewer.mock.invocationCallOrder[0]).toBeLessThan(
          write.mock.invocationCallOrder[0]
        );
        expect(session.shouldApplyInput('c1', 1)).toBe(false);
      } finally {
        write.mockRestore();
        ws.close();
      }
    });

    it('withholds the ACK and re-opens the seq when the write did not land', async () => {
      // A session whose PTY is gone swallows the write. ACKing anyway told the
      // client to drop the frame from its durable queue while the seq stayed
      // burnt, so the retry that reliable delivery exists for was rejected as a
      // duplicate — the input was lost for good.
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        const session = ctx._session;
        session.failWrites = true;

        ws.send(JSON.stringify({ t: 'i', d: 'lost\r', cid: 'c1', seq: 1 }));

        await expect(nextMessage(ws, 600)).rejects.toThrow(/timeout/);
        expect(session.shouldApplyInput('c1', 1)).toBe(true);
      } finally {
        ws.close();
      }
    });

    it('delivers and ACKs reliable input when viewer activation throws', async () => {
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        sizingSession.activateTerminalViewer.mockImplementationOnce(() => {
          throw new Error('sizing failed');
        });

        ws.send(JSON.stringify({ t: 'i', d: 'delivered\r', cid: 'activation-error', seq: 1 }));

        expect(await nextMessage(ws)).toEqual({ t: 'ia', seq: 1 });
        expect(ctx._session.writeBuffer).toEqual(['delivered\r']);
        expect(ctx._session.shouldApplyInput('activation-error', 1)).toBe(false);
      } finally {
        ws.close();
      }
    });

    it('rolls back a reliable seq when write throws so the same frame can retry once', async () => {
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      const session = ctx._session;
      const originalWrite = session.write.bind(session);
      const write = vi.spyOn(session, 'write').mockImplementationOnce(() => {
        throw new Error('write failed');
      });
      write.mockImplementation(originalWrite);
      try {
        const frame = JSON.stringify({ t: 'i', d: 'retry-once\r', cid: 'write-error', seq: 1 });
        ws.send(frame);

        await expect(nextMessage(ws, 200)).rejects.toThrow(/timeout/);
        expect(session.writeBuffer).toEqual([]);

        ws.send(frame);
        expect(await nextMessage(ws)).toEqual({ t: 'ia', seq: 1 });
        expect(session.writeBuffer).toEqual(['retry-once\r']);
        expect(write).toHaveBeenCalledTimes(2);
      } finally {
        write.mockRestore();
        ws.close();
      }
    });

    it('rolls back a reliable seq when checkpoint cancellation throws', async () => {
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      const session = ctx._session;
      session.isCheckpointActive = true;
      session.cancelCheckpoint.mockImplementationOnce(() => {
        throw new Error('checkpoint cancellation failed');
      });
      try {
        const frame = JSON.stringify({ t: 'i', d: 'retry-checkpoint\r', cid: 'checkpoint-error', seq: 1 });
        ws.send(frame);

        await expect(nextMessage(ws, 200)).rejects.toThrow(/timeout/);
        expect(session.writeBuffer).toEqual([]);

        ws.send(frame);
        expect(await nextMessage(ws)).toEqual({ t: 'ia', seq: 1 });
        expect(session.writeBuffer).toEqual(['retry-checkpoint\r']);
      } finally {
        ws.close();
      }
    });

    it('still ACKs a duplicate frame the server deliberately skipped', async () => {
      // Dedup must stay silent-but-acknowledged: the client has to be able to
      // drop a frame it already delivered once.
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        const session = ctx._session;
        session.shouldApplyInput('c1', 7); // pretend seq 7 already landed

        ws.send(JSON.stringify({ t: 'i', d: 'again\r', cid: 'c1', seq: 7 }));

        // The ACK now SAYS it was a duplicate and hands back the watermark: a bare
        // ACK is indistinguishable from "applied", and that ambiguity left a client
        // whose seq counter had rolled back silently unable to type at all.
        expect(await nextMessage(ws)).toEqual({ t: 'ia', seq: 7, dup: true, last: 7 });
        expect(session.writeBuffer).not.toContain('again\r');
        expect(session.cancelCheckpoint).not.toHaveBeenCalled();
        expect(sizingSession.activateTerminalViewer).not.toHaveBeenCalled();
      } finally {
        ws.close();
      }
    });

    it('ignores input exceeding MAX_INPUT_LENGTH', async () => {
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        const session = ctx._session;

        const hugeInput = 'x'.repeat(MAX_INPUT_LENGTH + 1);
        ws.send(JSON.stringify({ t: 'i', d: hugeInput }));

        // Send a valid message after to confirm the connection still works
        ws.send(JSON.stringify({ t: 'i', d: 'ok' }));

        await vi.waitFor(() => {
          expect(session.writeBuffer).toContain('ok');
        });

        // The oversized input should not have been written
        expect(session.writeBuffer).not.toContain(hugeInput);
      } finally {
        ws.close();
      }
    });

    it('ignores malformed JSON messages', async () => {
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        const session = ctx._session;

        ws.send('not-json{{{');

        // Send valid input to verify connection still alive
        ws.send(JSON.stringify({ t: 'i', d: 'after-bad' }));

        await vi.waitFor(() => {
          expect(session.writeBuffer).toContain('after-bad');
        });

        // Only 'after-bad' should be in the buffer
        expect(session.writeBuffer).toHaveLength(1);
      } finally {
        ws.close();
      }
    });

    it('ignores unknown message types without breaking the connection', async () => {
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        const session = ctx._session;

        // Send unknown type
        ws.send(JSON.stringify({ t: 'x', d: 'mystery' }));

        // Connection should still work
        ws.send(JSON.stringify({ t: 'i', d: 'still-alive' }));

        await vi.waitFor(() => {
          expect(session.writeBuffer).toContain('still-alive');
        });

        // Unknown type should not have been written
        expect(session.writeBuffer).toHaveLength(1);
      } finally {
        ws.close();
      }
    });
  });

  // ========== Viewer activation ==========

  describe('viewer activation', () => {
    it('hands sizing to a phone activation while retaining passive dimensions for desktop input fallback', async () => {
      type Dimensions = { cols: number; rows: number; viewportType: 'mobile' | 'tablet' | 'desktop' };
      const remembered = new Map<symbol, Dimensions>();
      const applied: Dimensions[] = [];
      let owner: symbol | null = null;

      sizingSession.activateTerminalViewer.mockImplementation((token: symbol, dimensions?: Dimensions) => {
        if (dimensions) remembered.set(token, dimensions);
        owner = token;
        const activeDimensions = remembered.get(token);
        if (activeDimensions) applied.push(activeDimensions);
      });
      sizingSession.resizeFromTerminalViewer.mockImplementation(
        (token: symbol, cols: number, rows: number, viewportType: Dimensions['viewportType']) => {
          const dimensions = { cols, rows, viewportType };
          remembered.set(token, dimensions);
          if (owner !== token) return false;
          applied.push(dimensions);
          return true;
        }
      );
      sizingSession.bootstrapTerminalViewer.mockImplementation((token: symbol) => {
        if (owner !== null) return false;
        owner = token;
        const dimensions = remembered.get(token);
        if (dimensions) applied.push(dimensions);
        return dimensions !== undefined;
      });

      const desktop = await connectWs('/ws/sessions/ws-test-session/terminal?cid=desktop');
      const phone = await connectWs('/ws/sessions/ws-test-session/terminal?cid=phone');
      try {
        desktop.send(JSON.stringify({ t: 'va', c: 140, r: 44, v: 'desktop' }));
        await vi.waitFor(() => expect(applied).toEqual([{ cols: 140, rows: 44, viewportType: 'desktop' }]));
        const desktopToken = sizingSession.activateTerminalViewer.mock.calls[0][0] as symbol;

        phone.send(JSON.stringify({ t: 'z', c: 75, r: 62, v: 'mobile' }));
        await vi.waitFor(() => expect(sizingSession.resizeFromTerminalViewer).toHaveBeenCalledTimes(1));
        const phoneToken = sizingSession.resizeFromTerminalViewer.mock.calls[0][0] as symbol;
        expect(owner).toBe(desktopToken);
        expect(applied).toHaveLength(1);

        phone.send(JSON.stringify({ t: 'va', c: 75, r: 62, v: 'mobile' }));
        await vi.waitFor(() => expect(owner).toBe(phoneToken));
        expect(applied).toEqual([
          { cols: 140, rows: 44, viewportType: 'desktop' },
          { cols: 75, rows: 62, viewportType: 'mobile' },
        ]);

        desktop.send(JSON.stringify({ t: 'z', c: 160, r: 48, v: 'desktop' }));
        await vi.waitFor(() => expect(remembered.get(desktopToken)?.cols).toBe(160));
        expect(owner).toBe(phoneToken);
        expect(applied).toHaveLength(2);

        desktop.send(JSON.stringify({ t: 'i', d: 'x', cid: 'desktop-input', seq: 1 }));
        expect(await nextMessage(desktop)).toEqual({ t: 'ia', seq: 1 });
        expect(owner).toBe(desktopToken);
        expect(applied.at(-1)).toEqual({ cols: 160, rows: 48, viewportType: 'desktop' });
        expect(ctx._session.writeBuffer).toContain('x');
      } finally {
        desktop.close();
        phone.close();
      }
    });

    it('uses one socket token for activation, resize, input fallback, and close without releasing another owner', async () => {
      let owner: symbol | null = null;
      sizingSession.activateTerminalViewer.mockImplementation((token: symbol) => {
        owner = token;
      });
      sizingSession.releaseTerminalViewer.mockImplementation((token: symbol) => {
        if (owner === token) owner = null;
      });

      const desktop = await connectWs('/ws/sessions/ws-test-session/terminal?cid=desktop-token');
      const phone = await connectWs('/ws/sessions/ws-test-session/terminal?cid=phone-token');
      try {
        desktop.send(JSON.stringify({ t: 'va', c: 140, r: 44, v: 'desktop' }));
        desktop.send(JSON.stringify({ t: 'z', c: 160, r: 48, v: 'desktop' }));
        desktop.send(JSON.stringify({ t: 'i', d: 'd' }));
        await vi.waitFor(() => expect(sizingSession.activateTerminalViewer).toHaveBeenCalledTimes(2));

        const desktopToken = sizingSession.activateTerminalViewer.mock.calls[0][0] as symbol;
        expect(sizingSession.activateTerminalViewer.mock.calls[1][0]).toBe(desktopToken);
        expect(sizingSession.resizeFromTerminalViewer.mock.calls[0][0]).toBe(desktopToken);

        phone.send(JSON.stringify({ t: 'va', c: 75, r: 62, v: 'mobile' }));
        await vi.waitFor(() => expect(sizingSession.activateTerminalViewer).toHaveBeenCalledTimes(3));
        const phoneToken = sizingSession.activateTerminalViewer.mock.calls[2][0] as symbol;
        expect(phoneToken).not.toBe(desktopToken);
        expect(owner).toBe(phoneToken);

        const desktopClosed = waitForClose(desktop);
        desktop.close();
        await desktopClosed;
        await vi.waitFor(() => expect(sizingSession.releaseTerminalViewer).toHaveBeenCalledWith(desktopToken));
        expect(sizingSession.releaseTerminalViewer.mock.calls.filter(([token]) => token === desktopToken)).toHaveLength(
          1
        );
        expect(owner).toBe(phoneToken);

        const phoneClosed = waitForClose(phone);
        phone.close();
        await phoneClosed;
        await vi.waitFor(() => expect(sizingSession.releaseTerminalViewer).toHaveBeenCalledWith(phoneToken));
        expect(sizingSession.releaseTerminalViewer.mock.calls.filter(([token]) => token === phoneToken)).toHaveLength(
          1
        );
        expect(owner).toBeNull();
      } finally {
        if (desktop.readyState === WebSocket.OPEN) desktop.close();
        if (phone.readyState === WebSocket.OPEN) phone.close();
      }
    });

    it('keeps ownerless passive sizing inactive until accepted input activates its remembered dimensions', async () => {
      type Dimensions = { cols: number; rows: number; viewportType: 'mobile' | 'tablet' | 'desktop' };
      const remembered = new Map<symbol, Dimensions>();
      const applied: Dimensions[] = [];
      let owner: symbol | null = null;
      sizingSession.resizeFromTerminalViewer.mockImplementation(
        (token: symbol, cols: number, rows: number, viewportType: Dimensions['viewportType']) => {
          const dimensions = { cols, rows, viewportType };
          remembered.set(token, dimensions);
          if (owner !== token) return false;
          applied.push(dimensions);
          return true;
        }
      );
      sizingSession.activateTerminalViewer.mockImplementation((token: symbol) => {
        owner = token;
        const dimensions = remembered.get(token);
        if (dimensions) applied.push(dimensions);
      });

      const ws = await connectWs('/ws/sessions/ws-test-session/terminal?cid=ownerless-passive');
      try {
        ws.send(JSON.stringify({ t: 'z', c: 92, r: 37, v: 'tablet' }));
        await vi.waitFor(() => expect(sizingSession.resizeFromTerminalViewer).toHaveBeenCalledTimes(1));
        const token = sizingSession.resizeFromTerminalViewer.mock.calls[0][0] as symbol;
        expect(owner).toBeNull();
        expect(applied).toEqual([]);
        expect(sizingSession.bootstrapTerminalViewer).not.toHaveBeenCalled();

        ws.send(JSON.stringify({ t: 'i', d: 'activate', cid: 'ownerless-input', seq: 1 }));
        expect(await nextMessage(ws)).toEqual({ t: 'ia', seq: 1 });
        expect(owner).toBe(token);
        expect(applied).toEqual([{ cols: 92, rows: 37, viewportType: 'tablet' }]);
      } finally {
        ws.close();
      }
    });

    it('does not let a reconnecting passive resize acquire ownerless sizing', async () => {
      const oldSocket = await connectWs('/ws/sessions/ws-test-session/terminal?cid=passive-reconnect');
      oldSocket.send(JSON.stringify({ t: 'va', c: 140, r: 44, v: 'desktop' }));
      await vi.waitFor(() => expect(sizingSession.activateTerminalViewer).toHaveBeenCalledTimes(1));
      const oldToken = sizingSession.activateTerminalViewer.mock.calls[0][0] as symbol;
      const oldClosed = waitForClose(oldSocket);

      const replacement = await connectWs('/ws/sessions/ws-test-session/terminal?cid=passive-reconnect');
      try {
        await oldClosed;
        await vi.waitFor(() => expect(sizingSession.releaseTerminalViewer).toHaveBeenCalledWith(oldToken));

        replacement.send(JSON.stringify({ t: 'z', c: 75, r: 62, v: 'mobile' }));
        await vi.waitFor(() => expect(sizingSession.resizeFromTerminalViewer).toHaveBeenCalledTimes(1));
        const replacementToken = sizingSession.resizeFromTerminalViewer.mock.calls[0][0] as symbol;
        expect(replacementToken).not.toBe(oldToken);
        expect(sizingSession.activateTerminalViewer).toHaveBeenCalledTimes(1);
        expect(sizingSession.bootstrapTerminalViewer).not.toHaveBeenCalled();
      } finally {
        replacement.close();
      }
    });

    it.each([
      ['missing viewport', { t: 'va', c: 120, r: 40 }],
      ['invalid viewport', { t: 'va', c: 120, r: 40, v: 'watch' }],
      ['fractional cols', { t: 'va', c: 120.5, r: 40, v: 'desktop' }],
      ['fractional rows', { t: 'va', c: 120, r: 40.5, v: 'desktop' }],
      ['cols below range', { t: 'va', c: 0, r: 40, v: 'desktop' }],
      ['cols above range', { t: 'va', c: 501, r: 40, v: 'desktop' }],
      ['rows below range', { t: 'va', c: 120, r: 0, v: 'desktop' }],
      ['rows above range', { t: 'va', c: 120, r: 201, v: 'desktop' }],
    ])('ignores invalid sizing activation: %s', async (_label, frame) => {
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        ws.send(JSON.stringify(frame));
        ws.send(JSON.stringify({ t: 'i', d: 'still-usable', cid: 'valid-after-invalid', seq: 1 }));

        expect(await nextMessage(ws)).toEqual({ t: 'ia', seq: 1 });
        expect(ctx._session.writeBuffer).toEqual(['still-usable']);
        expect(sizingSession.activateTerminalViewer).toHaveBeenCalledTimes(1);
        expect(sizingSession.activateTerminalViewer).toHaveBeenCalledWith(expect.any(Symbol));
        expect(sizingSession.resizeFromTerminalViewer).not.toHaveBeenCalled();
        expect(sizingSession.bootstrapTerminalViewer).not.toHaveBeenCalled();
      } finally {
        ws.close();
      }
    });

    it('applies a valid sizing activation without input or ACK side effects', async () => {
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      const messages: WebSocket.RawData[] = [];
      ws.on('message', (raw) => messages.push(raw));
      try {
        ws.send(JSON.stringify({ t: 'va', c: 75, r: 62, v: 'mobile' }));

        await vi.waitFor(() => {
          expect(sizingSession.activateTerminalViewer).toHaveBeenCalledWith(expect.any(Symbol), {
            cols: 75,
            rows: 62,
            viewportType: 'mobile',
          });
        });
        expect(ctx._session.writeBuffer).toEqual([]);
        expect(ctx._session.cancelCheckpoint).not.toHaveBeenCalled();
        expect(messages).toEqual([]);
      } finally {
        ws.close();
      }
    });
  });

  // ========== Resize validation ==========

  describe('resize validation', () => {
    it('accepts valid resize within bounds', async () => {
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        ws.send(JSON.stringify({ t: 'z', c: 120, r: 40 }));

        await vi.waitFor(() => {
          expect(sizingSession.resizeFromTerminalViewer).toHaveBeenCalledWith(
            expect.any(Symbol),
            120,
            40,
            'desktop',
            false
          );
        });
        const token = sizingSession.resizeFromTerminalViewer.mock.calls[0][0];
        expect(sizingSession.bootstrapTerminalViewer).not.toHaveBeenCalled();
        expect(sizingSession.activateTerminalViewer).not.toHaveBeenCalled();
      } finally {
        ws.close();
      }
    });

    it('passes viewport type through for resize arbitration', async () => {
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        ws.send(JSON.stringify({ t: 'z', c: 48, r: 28, v: 'mobile' }));

        await vi.waitFor(() => {
          expect(sizingSession.resizeFromTerminalViewer).toHaveBeenCalledWith(
            expect.any(Symbol),
            48,
            28,
            'mobile',
            false
          );
        });
        expect(sizingSession.bootstrapTerminalViewer).not.toHaveBeenCalled();
      } finally {
        ws.close();
      }
    });

    it('does not bootstrap when the current owner applied its resize', async () => {
      sizingSession.resizeFromTerminalViewer.mockReturnValue(true);
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        ws.send(JSON.stringify({ t: 'z', c: 120, r: 40, v: 'desktop' }));

        await vi.waitFor(() => {
          expect(sizingSession.resizeFromTerminalViewer).toHaveBeenCalledTimes(1);
        });
        expect(sizingSession.bootstrapTerminalViewer).not.toHaveBeenCalled();
      } finally {
        ws.close();
      }
    });

    it('passes force resize through for redraw requests', async () => {
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        ws.send(JSON.stringify({ t: 'z', c: 120, r: 40, f: true }));

        await vi.waitFor(() => {
          expect(sizingSession.resizeFromTerminalViewer).toHaveBeenCalledWith(
            expect.any(Symbol),
            120,
            40,
            'desktop',
            true
          );
        });
        expect(sizingSession.bootstrapTerminalViewer).not.toHaveBeenCalled();
      } finally {
        ws.close();
      }
    });

    it('remembers passive resizes under one connection token and releases it on close', async () => {
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      let token: symbol;
      try {
        ws.send(JSON.stringify({ t: 'z', c: 160, r: 48, v: 'desktop' }));

        await vi.waitFor(() => {
          expect(sizingSession.resizeFromTerminalViewer).toHaveBeenCalledTimes(1);
        });
        token = sizingSession.resizeFromTerminalViewer.mock.calls[0][0] as symbol;
        expect(sizingSession.activateTerminalViewer).not.toHaveBeenCalled();

        ws.send(JSON.stringify({ t: 'z', c: 48, r: 28, v: 'tablet' }));
        await vi.waitFor(() => {
          expect(sizingSession.resizeFromTerminalViewer).toHaveBeenLastCalledWith(token, 48, 28, 'tablet', false);
        });
      } finally {
        ws.close();
      }

      await vi.waitFor(() => {
        expect(sizingSession.releaseTerminalViewer).toHaveBeenCalledWith(token);
      });
    });

    it('accepts resize at minimum bounds (1x1)', async () => {
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        ws.send(JSON.stringify({ t: 'z', c: 1, r: 1 }));

        await vi.waitFor(() => {
          expect(sizingSession.resizeFromTerminalViewer).toHaveBeenCalledWith(
            expect.any(Symbol),
            1,
            1,
            'desktop',
            false
          );
        });
      } finally {
        ws.close();
      }
    });

    it('accepts resize at maximum bounds (500x200)', async () => {
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        ws.send(JSON.stringify({ t: 'z', c: 500, r: 200 }));

        await vi.waitFor(() => {
          expect(sizingSession.resizeFromTerminalViewer).toHaveBeenCalledWith(
            expect.any(Symbol),
            500,
            200,
            'desktop',
            false
          );
        });
      } finally {
        ws.close();
      }
    });

    it('rejects resize with cols out of bounds (0 cols)', async () => {
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        const session = ctx._session;

        ws.send(JSON.stringify({ t: 'z', c: 0, r: 40 }));

        // Send a valid message to confirm processing continues
        ws.send(JSON.stringify({ t: 'i', d: 'sentinel' }));
        await vi.waitFor(() => {
          expect(session.writeBuffer).toContain('sentinel');
        });

        expect(sizingSession.resizeFromTerminalViewer).not.toHaveBeenCalled();
      } finally {
        ws.close();
      }
    });

    it('rejects resize with cols exceeding 500', async () => {
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        const session = ctx._session;

        ws.send(JSON.stringify({ t: 'z', c: 501, r: 40 }));

        ws.send(JSON.stringify({ t: 'i', d: 'sentinel' }));
        await vi.waitFor(() => {
          expect(session.writeBuffer).toContain('sentinel');
        });

        expect(sizingSession.resizeFromTerminalViewer).not.toHaveBeenCalled();
      } finally {
        ws.close();
      }
    });

    it('rejects resize with rows exceeding 200', async () => {
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        const session = ctx._session;

        ws.send(JSON.stringify({ t: 'z', c: 80, r: 201 }));

        ws.send(JSON.stringify({ t: 'i', d: 'sentinel' }));
        await vi.waitFor(() => {
          expect(session.writeBuffer).toContain('sentinel');
        });

        expect(sizingSession.resizeFromTerminalViewer).not.toHaveBeenCalled();
      } finally {
        ws.close();
      }
    });

    it('rejects resize with non-integer values', async () => {
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        const session = ctx._session;

        ws.send(JSON.stringify({ t: 'z', c: 80.5, r: 24 }));

        ws.send(JSON.stringify({ t: 'i', d: 'sentinel' }));
        await vi.waitFor(() => {
          expect(session.writeBuffer).toContain('sentinel');
        });

        expect(sizingSession.resizeFromTerminalViewer).not.toHaveBeenCalled();
      } finally {
        ws.close();
      }
    });

    it('rejects resize with negative values', async () => {
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        const session = ctx._session;

        ws.send(JSON.stringify({ t: 'z', c: -1, r: 24 }));

        ws.send(JSON.stringify({ t: 'i', d: 'sentinel' }));
        await vi.waitFor(() => {
          expect(session.writeBuffer).toContain('sentinel');
        });

        expect(sizingSession.resizeFromTerminalViewer).not.toHaveBeenCalled();
      } finally {
        ws.close();
      }
    });
  });

  // ========== Connection limit ==========

  describe('connection limit', () => {
    it('closes with 4008 when too many connections per session', async () => {
      const connections: WebSocket[] = [];
      try {
        // Open 5 connections (the max)
        for (let i = 0; i < 5; i++) {
          connections.push(await connectWs('/ws/sessions/ws-test-session/terminal'));
        }

        // 6th connection should be rejected
        const ws6 = new WebSocket(`ws://127.0.0.1:${PORT}/ws/sessions/ws-test-session/terminal`);
        const { code, reason } = await waitForClose(ws6);
        expect(code).toBe(4008);
        expect(reason).toBe('Too many connections');
      } finally {
        for (const ws of connections) ws.close();
      }
    });

    it('reconnecting client (same cid) is admitted at the cap instead of 4008 (COD-137)', async () => {
      const connections: WebSocket[] = [];
      try {
        // Fill all 5 slots with DISTINCT clients, one of which is "alice".
        for (const c of ['alice', 'b', 'c', 'd', 'e']) {
          connections.push(await connectWs(`/ws/sessions/ws-test-session/terminal?cid=${c}`));
        }

        // Alice reconnects WHILE her old socket is still registered (the
        // over-count window). This must reclaim her slot, not hit the cap.
        const aliceNew = await connectWs('/ws/sessions/ws-test-session/terminal?cid=alice');
        connections.push(aliceNew);

        // Sanity: the reconnected socket is live and usable.
        ctx._session.emit('terminal', 'reconnected-ok');
        const msg = (await nextMessage(aliceNew)) as { t: string; d: string };
        expect(msg.t).toBe('o');
        expect(msg.d).toContain('reconnected-ok');
      } finally {
        for (const ws of connections) ws.close();
      }
    });
  });

  // ========== Heartbeat ==========

  describe('heartbeat', () => {
    it('responds to server ping with pong (connection stays alive)', async () => {
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        // The ws library automatically responds to pings with pongs.
        // Verify the connection survives by sending data after a brief delay.
        const session = ctx._session;
        session.emit('terminal', 'heartbeat-test');

        const msg = (await nextMessage(ws)) as { t: string; d: string };
        expect(msg.t).toBe('o');
        expect(msg.d).toContain('heartbeat-test');
      } finally {
        ws.close();
      }
    });
  });

  // ========== readyState guards ==========

  describe('readyState guards', () => {
    it('does not throw when clearTerminal fires after close', async () => {
      const session = ctx._session;
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');

      ws.close();
      await waitForClose(ws);

      // These should be no-ops, not throw
      expect(() => session.emit('clearTerminal')).not.toThrow();
      expect(() => session.emit('needsRefresh')).not.toThrow();
    });
  });

  // ========== Connection cleanup ==========

  describe('connection cleanup', () => {
    it('removes session event listeners on close', async () => {
      const session = ctx._session;
      const listenersBefore = session.listenerCount('terminal');

      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');

      // A listener was added for 'terminal'
      expect(session.listenerCount('terminal')).toBe(listenersBefore + 1);
      expect(session.listenerCount('clearTerminal')).toBeGreaterThanOrEqual(1);
      expect(session.listenerCount('needsRefresh')).toBeGreaterThanOrEqual(1);

      // Close the WS connection
      ws.close();
      await waitForClose(ws);

      // Wait for server-side close handler
      await vi.waitFor(() => {
        expect(session.listenerCount('terminal')).toBe(listenersBefore);
      });

      expect(session.listenerCount('clearTerminal')).toBe(0);
      expect(session.listenerCount('needsRefresh')).toBe(0);
    });
  });
});
