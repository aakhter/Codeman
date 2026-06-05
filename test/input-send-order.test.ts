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

describe('CodemanApp input dispatch ordering', () => {
  it('serializes HTTP fallback input requests until each send completes', async () => {
    const CodemanApp = loadCodemanAppClass();
    const app = Object.create(CodemanApp.prototype) as {
      _sendInputAsync: (sessionId: string, input: string) => void;
      _inputSendChain: Promise<void>;
      _inputQueue: Map<string, string>;
      isOnline: boolean;
      _connectionStatus: string;
      _wsReady: boolean;
      _wsSessionId: string | null;
      clearPendingHooks: () => void;
      _enqueueInput: () => void;
    };

    app._inputSendChain = Promise.resolve();
    app._inputQueue = new Map();
    app.isOnline = true;
    app._connectionStatus = 'connected';
    app._wsReady = false;
    app._wsSessionId = null;
    app.clearPendingHooks = vi.fn();
    app._enqueueInput = vi.fn();

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

    expect(calls).toEqual(['a']);

    completions.shift()?.();
    await waitForCalls(calls, 2);

    expect(calls).toEqual(['a', 'b']);

    completions.shift()?.();
    await app._inputSendChain;
  });
});
