/**
 * @fileoverview Input dispatch ordering for the durable, acknowledged delivery
 * layer (`CodemanApp._sendInputAsync` → `_reliableSend` → `_drainSession`).
 *
 * Local replaced the upstream best-effort "coalescing fallback queue" with the
 * durable per-(clientId, seq) layer in commit 1255e28 (docs/reliable-input-
 * delivery.md). This suite verifies the client-side ordering guarantees of that
 * layer: each input is a distinct seq-tagged frame, delivered in order over the
 * WebSocket when ownership-capable transport is open and retained durably when
 * it is not. Exactly-once application is covered server-side in
 * test/reliable-input-dedup.test.ts.
 *
 * Loaded via `vm` with a stubbed context (no jsdom).
 */
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const reliableStorage = new Map<string, string>();

function loadCodemanAppClass() {
  const constants = readFileSync(resolve(import.meta.dirname, '../src/web/public/constants.js'), 'utf8');
  const source = readFileSync(resolve(import.meta.dirname, '../src/web/public/app.js'), 'utf8');
  const context = vm.createContext({
    console,
    performance,
    setInterval: vi.fn(),
    clearInterval: vi.fn(),
    setTimeout,
    clearTimeout,
    requestAnimationFrame: vi.fn(),
    HTMLCanvasElement: class HTMLCanvasElement {},
    WebSocket: { OPEN: 1 },
    fetch: (...args: Parameters<typeof fetch>) => global.fetch(...args),
    document: { addEventListener: vi.fn() },
    localStorage: {
      get length() {
        return reliableStorage.size;
      },
      key: (index: number) => [...reliableStorage.keys()][index] ?? null,
      getItem: (key: string) => reliableStorage.get(key) ?? null,
      setItem: (key: string, value: string) => reliableStorage.set(key, value),
      removeItem: (key: string) => reliableStorage.delete(key),
    },
    window: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
    MobileDetection: {},
  });
  vm.runInContext(`${constants}\n${source}\nglobalThis.__CodemanApp = CodemanApp;`, context);
  return (context as { __CodemanApp: new () => unknown }).__CodemanApp;
}

const CodemanApp = loadCodemanAppClass();

type Frame = { t: string; d: string; seq: number; cid: string };

type App = {
  _sendInputAsync: (sessionId: string, input: string, opts?: { useMux?: boolean }) => void;
  _pendingDeliveries: Map<string, Array<{ seq: number; data: string; sentAt: number }>>;
  _ws: { readyState: number; send: (data: string) => void } | null;
  _wsSessionId: string | null;
  activeSessionId: string | null;
};

const INPUT_CASES = [
  ['500 identical printable characters', 'x'.repeat(500)],
  ['repeated runs', 'aaabbb111___'],
  ['printable/control/Enter boundaries', `ab\x03cd\x1bef\r`],
  ['paste near the configured input limit', 'paste-'.repeat(10_922).slice(0, 65_520)],
] as const;

function makeApp(): App {
  const app = Object.create((CodemanApp as { prototype: object }).prototype) as App & Record<string, unknown>;
  app._clientId = 'c-test';
  app._seqCounters = new Map();
  app._pendingDeliveries = new Map();
  app._persistReliableState = vi.fn();
  app._persistReliableNow = vi.fn();
  app._updateConnectionIndicator = vi.fn();
  app.clearPendingHooks = vi.fn();
  // _ackDelivery spends a pending IDLE alert through markIdleAlertSeen, which
  // reads this map; without it the real prototype method throws on every ACK.
  app.pendingHooks = new Map();
  app.activeSessionId = 'session-1';
  app.isOnline = true;
  app._connectionStatus = 'connected';
  app._terminalViewerActivity = {
    activate: vi.fn(() => true),
    hasPending: vi.fn(() => false),
    isCurrentTransportActivated: vi.fn(() => true),
  };
  app._ws = null;
  app._wsSessionId = null;
  app._wsReady = true;
  return app as unknown as App;
}

describe('durable input delivery — send ordering', () => {
  it('rejects public input for the exact active gone session before ownership activation', () => {
    const app = makeApp() as App & Record<string, any>;
    app._wsState = 'gone';
    app._wsGoneSessionId = 'session-1';

    app._sendInputAsync('session-1', 'must-not-queue');

    expect(app._terminalViewerActivity.activate).not.toHaveBeenCalled();
    expect(app._pendingDeliveries.has('session-1')).toBe(false);
    expect(app._seqCounters.has('session-1')).toBe(false);
  });

  it('preserves public input for another session when the prior terminal is gone', () => {
    const app = makeApp() as App & Record<string, any>;
    app._wsState = 'gone';
    app._wsGoneSessionId = 'gone-session';

    app._sendInputAsync('session-1', 'still-valid');

    expect(app._terminalViewerActivity.activate).toHaveBeenCalledWith('terminal-input');
    expect(app._pendingDeliveries.get('session-1')).toMatchObject([{ data: 'still-valid' }]);
  });

  it('retains input without HTTP while WS activation is unavailable', async () => {
    const app = makeApp() as App & Record<string, any>;
    const activate = vi.fn(() => false);
    app._terminalViewerActivity = { activate, hasPending: vi.fn(() => true) };
    global.fetch = vi.fn();

    app._sendInputAsync('session-1', 'owned-after-reconnect');
    await new Promise((resolveWait) => setTimeout(resolveWait, 0));

    expect(activate).toHaveBeenCalledWith('terminal-input');
    expect(global.fetch).not.toHaveBeenCalled();
    expect(app._pendingDeliveries.get('session-1')).toMatchObject([
      { seq: 1, data: 'owned-after-reconnect', tries: 0, sentAt: 0 },
    ]);
  });

  it('redelivers send-throw input exactly once over the replacement WS', () => {
    const app = makeApp() as App & Record<string, any>;
    let transportActivated = false;
    const activate = vi.fn(() => {
      try {
        app._ws.send(JSON.stringify({ t: 'va', c: 80, r: 24, v: 'desktop' }));
        transportActivated = true;
        return true;
      } catch {
        return false;
      }
    });
    app._terminalViewerActivity = {
      activate,
      hasPending: vi.fn(() => false),
      isCurrentTransportActivated: vi.fn(() => transportActivated),
    };
    app._wsSessionId = 'session-1';
    const oldFrames: Frame[] = [];
    app._ws = {
      readyState: 1,
      send: vi.fn((data: string) => {
        const frame = JSON.parse(data) as Frame;
        if (frame.t === 'i') throw new Error('input socket failed');
        oldFrames.push(frame);
      }),
    };

    app._sendInputAsync('session-1', 'retry-on-fresh-socket');
    expect(oldFrames).toMatchObject([{ t: 'va', c: 80, r: 24, v: 'desktop' }]);
    expect(app._pendingDeliveries.get('session-1')).toMatchObject([
      { seq: 1, data: 'retry-on-fresh-socket', sentAt: 0 },
    ]);

    const frames: Frame[] = [];
    transportActivated = false;
    app._ws = { readyState: 1, send: (data: string) => frames.push(JSON.parse(data)) };
    app._onWsReady('session-1');
    expect(frames).toHaveLength(2);
    expect(frames[0]).toMatchObject({ t: 'va', c: 80, r: 24, v: 'desktop' });
    expect(frames[1]).toMatchObject({ t: 'i', d: 'retry-on-fresh-socket', seq: 1, cid: 'c-test' });
    app._onWsInputAck(1);
    app._onWsReady('session-1');
    expect(frames).toHaveLength(2);
  });

  it('does not send input after activation throws and replays it after activation recovery', () => {
    const app = makeApp() as App & Record<string, any>;
    let activationPending = false;
    let transportActivated = false;
    app._wsSessionId = 'session-1';
    app._ws = {
      readyState: 1,
      send: vi.fn(() => {
        throw new Error('activation socket failed');
      }),
    };
    app._terminalViewerActivity = {
      activate: vi.fn(() => {
        try {
          app._ws.send(JSON.stringify({ t: 'va', c: 80, r: 24, v: 'desktop' }));
          transportActivated = true;
          return true;
        } catch {
          activationPending = true;
          return false;
        }
      }),
      hasPending: vi.fn(() => activationPending),
      isCurrentTransportActivated: vi.fn(() => transportActivated),
    };

    app._sendInputAsync('session-1', 'after-owned-reconnect');
    expect(app._ws.send).toHaveBeenCalledOnce();
    expect(app._pendingDeliveries.get('session-1')).toMatchObject([
      { seq: 1, data: 'after-owned-reconnect', sentAt: 0, tries: 0 },
    ]);

    activationPending = false;
    const frames: Frame[] = [];
    app._ws = { readyState: 1, send: (data: string) => frames.push(JSON.parse(data)) };
    app._onWsReady('session-1');
    expect(frames).toHaveLength(2);
    expect(frames[0]).toMatchObject({ t: 'va' });
    expect(frames[1]).toMatchObject({ t: 'i', d: 'after-owned-reconnect', seq: 1 });
  });

  it('sends ownership activation before input on the same live WS', () => {
    const app = makeApp() as App & Record<string, any>;
    const frames: Array<Record<string, unknown>> = [];
    app._wsSessionId = 'session-1';
    app._ws = { readyState: 1, send: (data: string) => frames.push(JSON.parse(data)) };
    app._terminalViewerActivity = {
      activate: vi.fn(() => {
        app._ws.send(JSON.stringify({ t: 'va', c: 80, r: 24, v: 'desktop' }));
        return true;
      }),
      hasPending: vi.fn(() => false),
    };

    app._sendInputAsync('session-1', 'after-va');

    expect(frames).toEqual([
      { t: 'va', c: 80, r: 24, v: 'desktop' },
      { t: 'i', d: 'after-va', seq: 1, cid: 'c-test' },
    ]);
  });

  it.each(INPUT_CASES)('preserves %s as one exact WebSocket record', (_label, input) => {
    const app = makeApp();
    const frames: Frame[] = [];
    app._ws = { readyState: 1, send: (data: string) => frames.push(JSON.parse(data)) };
    app._wsSessionId = 'session-1';

    app._sendInputAsync('session-1', input);

    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ t: 'i', d: input, seq: 1, cid: 'c-test' });
    expect(Buffer.from(frames[0].d)).toEqual(Buffer.from(input));
  });

  it.each(INPUT_CASES)('preserves %s while offline and replays it over the replacement WS', (_label, input) => {
    const app = makeApp();
    const fetchMock = vi.fn();
    global.fetch = fetchMock;

    app._sendInputAsync('session-1', input);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(app._pendingDeliveries.get('session-1')).toMatchObject([{ seq: 1, data: input, sentAt: 0 }]);

    const frames: Frame[] = [];
    app._ws = { readyState: 1, send: (data: string) => frames.push(JSON.parse(data)) };
    app._wsSessionId = 'session-1';
    app._onWsReady('session-1');

    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ t: 'i', d: input, seq: 1, cid: 'c-test' });
    expect(Buffer.from(frames[0].d)).toEqual(Buffer.from(input));
  });

  it('delivers rapid input as distinct ordered seq frames over an open WebSocket (no coalescing)', () => {
    const app = makeApp();
    const frames: Frame[] = [];
    app._ws = { readyState: 1, send: (d: string) => frames.push(JSON.parse(d)) };
    app._wsSessionId = 'session-1';

    app._sendInputAsync('session-1', 'a');
    app._sendInputAsync('session-1', 'b');
    app._sendInputAsync('session-1', 'c');

    // Each keystroke is its own frame, in seq order — never merged into "abc".
    expect(frames.map((f) => f.d)).toEqual(['a', 'b', 'c']);
    expect(frames.map((f) => f.seq)).toEqual([1, 2, 3]);
    expect(frames.every((f) => f.t === 'i' && f.cid === 'c-test')).toBe(true);
  });

  it('retains rapid queued input in seq order and replays it over the replacement WS', () => {
    const app = makeApp();
    global.fetch = vi.fn();

    app._sendInputAsync('session-1', 'a');
    app._sendInputAsync('session-1', 'b');
    expect(global.fetch).not.toHaveBeenCalled();
    expect(app._pendingDeliveries.get('session-1')?.map((record) => record.data)).toEqual(['a', 'b']);

    const frames: Frame[] = [];
    app._ws = { readyState: 1, send: (data: string) => frames.push(JSON.parse(data)) };
    app._wsSessionId = 'session-1';
    app._onWsReady('session-1');
    expect(frames.map((frame) => frame.d)).toEqual(['a', 'b']);
    expect(frames.map((frame) => frame.seq)).toEqual([1, 2]);
  });

  it('leaves a frame queued without attempting HTTP while WS is unavailable', async () => {
    const app = makeApp();
    global.fetch = vi.fn();

    app._sendInputAsync('session-1', 'a');
    await new Promise((r) => setTimeout(r, 0));

    expect(global.fetch).not.toHaveBeenCalled();
    expect(app._pendingDeliveries.get('session-1')).toHaveLength(1);
    expect(app._pendingDeliveries.get('session-1')?.[0].data).toBe('a');
  });

  it('does not let an HTTP 404 consume a browser record that was never posted', async () => {
    const app = makeApp();
    const fetchMock = vi.fn(async () => new Response('gone', { status: 404 }));
    global.fetch = fetchMock;

    app._sendInputAsync('session-1', 'a');
    await new Promise((r) => setTimeout(r, 0));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(app._pendingDeliveries.get('session-1')).toHaveLength(1);
  });
});

// COD-135 — durable redelivery sweep when an ACK is lost.
type RedriveApp = App & {
  _redeliverSweep: () => void;
  _reliableAckTimeoutMs: number;
  _wsLastRecvAt: number;
};

describe('durable input delivery — _redeliverSweep ACK-loss recovery (COD-135)', () => {
  it('re-drives a stale unacked frame over a STILL-LIVE socket (lost ACK, not silent)', () => {
    const app = makeApp() as RedriveApp;
    const frames: Frame[] = [];
    const close = vi.fn();
    app._ws = { readyState: 1, send: (d: string) => frames.push(JSON.parse(d)), close } as never;
    app._wsSessionId = 'session-1';
    app._reliableAckTimeoutMs = 4000;

    // Frame sent once over the open socket; ACK never arrives.
    app._sendInputAsync('session-1', 'a');
    expect(frames.map((f) => f.d)).toEqual(['a']);

    // ACK is lost, but the socket KEEPS receiving output → it is NOT silent.
    // Backdate the send so the frame is stale; keep recv timestamp fresh.
    const list = app._pendingDeliveries.get('session-1')!;
    list[0].sentAt = Date.now() - (app._reliableAckTimeoutMs + 1000);
    app._wsLastRecvAt = Date.now();

    app._redeliverSweep();

    // The stale frame must be re-sent over the live socket (a second send),
    // and the socket must NOT be force-closed (it's alive, just the ACK was lost).
    expect(frames.map((f) => f.d)).toEqual(['a', 'a']);
    expect(close).not.toHaveBeenCalled();
    expect(app._pendingDeliveries.get('session-1')).toHaveLength(1);
  });

  it('does NOT re-drive a not-yet-stale frame (sent recently)', () => {
    const app = makeApp() as RedriveApp;
    const frames: Frame[] = [];
    const close = vi.fn();
    app._ws = { readyState: 1, send: (d: string) => frames.push(JSON.parse(d)), close } as never;
    app._wsSessionId = 'session-1';
    app._reliableAckTimeoutMs = 4000;

    app._sendInputAsync('session-1', 'a');
    app._wsLastRecvAt = Date.now(); // not silent

    // sentAt is fresh (just sent) → below the stale threshold → leave it alone.
    app._redeliverSweep();

    expect(frames.map((f) => f.d)).toEqual(['a']); // no second send
    expect(close).not.toHaveBeenCalled();
  });

  it('force-closes the socket when stale AND silent (half-open — COD-134 fallback preserved)', () => {
    const app = makeApp() as RedriveApp;
    const frames: Frame[] = [];
    const close = vi.fn();
    app._ws = { readyState: 1, send: (d: string) => frames.push(JSON.parse(d)), close } as never;
    app._wsSessionId = 'session-1';
    app._reliableAckTimeoutMs = 4000;

    app._sendInputAsync('session-1', 'a');
    const list = app._pendingDeliveries.get('session-1')!;
    list[0].sentAt = Date.now() - (app._reliableAckTimeoutMs + 1000); // stale
    app._wsLastRecvAt = Date.now() - (app._reliableAckTimeoutMs + 1000); // silent

    app._redeliverSweep();

    // Half-open socket never recovers on its own → force-close to reconnect.
    // It must NOT have re-sent over the dead socket.
    expect(close).toHaveBeenCalledTimes(1);
    expect(frames.map((f) => f.d)).toEqual(['a']);
  });
});

describe('durable input delivery — persistence boundaries', () => {
  it('restores pending records with the same client and sequence after reload', () => {
    const app = makeApp() as App & Record<string, any>;
    reliableStorage.clear();
    reliableStorage.set('codeman:clientId', 'c-test');
    try {
      app._reliableMaxBytes = 1024 * 1024;
      app._persistReliableTimer = null;
      delete app._persistReliableNow;
      app._sendInputAsync('session-1', 'pending');
      app._persistReliableNow();

      const restored = makeApp() as App & Record<string, any>;
      restored._clientId = '';
      restored._loadReliableState();

      expect(restored._clientId).toBe('c-test');
      expect(restored._pendingDeliveries.get('session-1')).toMatchObject([
        { seq: 1, data: 'pending', tries: 0, sentAt: 0 },
      ]);
    } finally {
      reliableStorage.clear();
    }
  });

  it('persists an empty durable queue immediately after ACK before a server restart/reload', () => {
    const app = makeApp() as App & Record<string, any>;
    app._reliableMaxBytes = 1024 * 1024;
    app._persistReliableNow = vi.fn();
    app._ws = { readyState: 1, send: vi.fn() };
    app._wsSessionId = 'session-1';

    app._sendInputAsync('session-1', 'once');
    app._onWsInputAck(1);

    expect(app._pendingDeliveries.size).toBe(0);
    // Persist the sequence before sending, then persist the empty queue after ACK.
    expect(app._persistReliableNow).toHaveBeenCalledTimes(2);
  });
});
