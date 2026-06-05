import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

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
    fetch: (...args: Parameters<typeof fetch>) => global.fetch(...args),
    document: { addEventListener: vi.fn() },
    localStorage: {
      length: 0,
      key: vi.fn(),
      getItem: vi.fn(),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    },
    window: {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
    MobileDetection: {},
  });

  vm.runInContext(`${constants}\n${source}\nglobalThis.__CodemanApp = CodemanApp;`, context);
  return (context as { __CodemanApp: new () => unknown }).__CodemanApp;
}

async function waitForCalls(calls: string[], count: number) {
  for (let i = 0; i < 20; i++) {
    if (calls.length >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function fakeElement() {
  const classes = new Set<string>();
  return {
    style: { display: '' },
    title: '',
    textContent: '',
    className: '',
    classList: {
      add: (...names: string[]) => {
        names.forEach((name) => classes.add(name));
      },
      contains: (name: string) => classes.has(name),
    },
  };
}

describe('CodemanApp input dispatch ordering', () => {
  function makeApp() {
    const CodemanApp = loadCodemanAppClass();
    const app = Object.create(CodemanApp.prototype) as {
      _sendInputAsync: (sessionId: string, input: string) => void;
      _inputSendChain: Promise<void>;
      _inputQueue: Map<string, string>;
      _httpInputQueues?: Map<string, string>;
      _httpInputDrainActive?: boolean;
      _httpFallbackGraceMs?: number;
      _flushHttpFallbackQueuesViaWs?: () => boolean;
      activeSessionId: string | null;
      isOnline: boolean;
      _connectionStatus: string;
      _wsReady: boolean;
      _wsSessionId: string | null;
      _wsState?: string;
      _ws?: { send: (data: string) => void };
      clearPendingHooks: () => void;
      _enqueueInput: () => void;
      $: (id: string) => any;
    };

    app._inputSendChain = Promise.resolve();
    app._inputQueue = new Map();
    app._httpInputQueues = new Map();
    app._httpInputDrainActive = false;
    app._httpFallbackGraceMs = 150;
    app.activeSessionId = 'session-1';
    app.isOnline = true;
    app._connectionStatus = 'connected';
    app._wsReady = false;
    app._wsSessionId = null;
    app._wsState = 'disconnected';
    app.clearPendingHooks = vi.fn();
    app._enqueueInput = vi.fn();
    app.$ = vi.fn();

    return app;
  }

  it('coalesces rapid HTTP fallback input while preserving character order', async () => {
    const app = makeApp();

    const completions: Array<() => void> = [];
    const calls: string[] = [];
    global.fetch = vi.fn(async (_url, init) => {
      calls.push(JSON.parse(String(init?.body)).input);
      await new Promise<void>((resolve) => completions.push(resolve));
      return new Response('{}', { status: 200 });
    });

    app._sendInputAsync('session-1', 'a');
    app._sendInputAsync('session-1', 'b');
    await Promise.resolve();
    await Promise.resolve();

    expect(calls).toEqual(['ab']);

    completions.shift()?.();
    await app._inputSendChain;

    expect(calls).toEqual(['ab']);
  });

  it('waits for an in-flight HTTP fallback send before dispatching the next combined chunk', async () => {
    const app = makeApp();

    const completions: Array<() => void> = [];
    const calls: string[] = [];
    global.fetch = vi.fn(async (_url, init) => {
      calls.push(JSON.parse(String(init?.body)).input);
      await new Promise<void>((resolve) => completions.push(resolve));
      return new Response('{}', { status: 200 });
    });

    app._sendInputAsync('session-1', 'a');
    await waitForCalls(calls, 1);
    app._sendInputAsync('session-1', 'b');
    app._sendInputAsync('session-1', 'c');
    await Promise.resolve();

    expect(calls).toEqual(['a']);

    completions.shift()?.();
    await waitForCalls(calls, 2);

    expect(calls).toEqual(['a', 'bc']);
    completions.shift()?.();
    await app._inputSendChain;
  });

  it('flushes connecting-state input over WebSocket when the socket opens during the grace window', async () => {
    const app = makeApp();
    const httpCalls: string[] = [];
    const wsCalls: string[] = [];
    global.fetch = vi.fn(async (_url, init) => {
      httpCalls.push(JSON.parse(String(init?.body)).input);
      return new Response('{}', { status: 200 });
    });

    app._wsState = 'connecting';
    app._sendInputAsync('session-1', 'a');
    app._sendInputAsync('session-1', 'b');
    await Promise.resolve();

    expect(httpCalls).toEqual([]);

    app._wsReady = true;
    app._wsSessionId = 'session-1';
    app._ws = {
      send: (data: string) => wsCalls.push(JSON.parse(data).d),
    };

    expect(app._flushHttpFallbackQueuesViaWs?.()).toBe(true);
    expect(wsCalls).toEqual(['ab']);
    expect(httpCalls).toEqual([]);
  });

  it('shows WebSocket and HTTP fallback transport states in the header indicator', () => {
    const app = makeApp();
    const indicator = fakeElement();
    const dot = fakeElement();
    const text = fakeElement();
    app.activeSessionId = 'session-1';
    app.$ = (id: string) =>
      ({
        connectionIndicator: indicator,
        connectionDot: dot,
        connectionText: text,
      })[id] ?? null;

    app._wsReady = true;
    app._wsSessionId = 'session-1';
    app._updateConnectionIndicator();

    expect(indicator.style.display).toBe('flex');
    expect(dot.classList.contains('connected')).toBe(true);
    expect(text.textContent).toBe('WS');

    app._wsReady = false;
    app._httpInputQueues?.set('session-1', 'abc');
    app._updateConnectionIndicator();

    expect(dot.classList.contains('fallback')).toBe(true);
    expect(text.textContent).toContain('HTTP fallback');
  });
});
