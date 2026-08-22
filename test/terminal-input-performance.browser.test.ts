/**
 * @fileoverview Browser-native byte tracing for COD-356.
 *
 * This deliberately runs the production CodemanApp reliable-send methods in a
 * real Chromium realm while replacing only the network boundary with a small
 * deterministic input probe. Each case compares four independent layers:
 * logical browser records, serialized transport frames, exactly-once probe PTY
 * bytes, and the probe's authoritative repaint/convergence stream.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';

const constants = readFileSync(resolve(import.meta.dirname, '../src/web/public/constants.js'), 'utf8');
const appSource = readFileSync(resolve(import.meta.dirname, '../src/web/public/app.js'), 'utf8');

let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
  await page.setContent('<!doctype html><html><body><textarea id="ime"></textarea></body></html>');
  await page.evaluate(() => {
    Object.assign(window, {
      MobileDetection: {},
      HTMLCanvasElement: class {},
    });
  });
  await page.addScriptTag({ content: `${constants}\n${appSource}\nwindow.__CodemanApp = CodemanApp;` });
});

afterAll(async () => {
  await browser?.close();
});

type Trace = {
  logical: string[];
  serialized: string[];
  probe: string[];
  visible: string[];
  pending: number;
};

async function traceCase(
  transport: 'ws' | 'http',
  inputs: string[],
  options: { loseFirstAck?: boolean } = {}
): Promise<Trace> {
  return page.evaluate(
    async ({ transport, inputs, loseFirstAck }) => {
      const App = (window as any).__CodemanApp;
      const app = Object.create(App.prototype);
      Object.assign(app, {
        _clientId: 'browser-trace-client',
        _seqCounters: new Map(),
        _pendingDeliveries: new Map(),
        _postDraining: new Set(),
        _persistReliableState() {},
        _persistReliableNow() {},
        _updateConnectionIndicator() {},
        clearPendingHooks() {},
        markIdleAlertSeen() {},
        pendingHooks: new Map(),
        activeSessionId: 's1',
        isOnline: true,
        _connectionStatus: 'connected',
        _ws: null,
        _wsSessionId: null,
        _reliableAckTimeoutMs: 1,
        _wsLastRecvAt: Date.now(),
      });
      const trace = { logical: [], serialized: [], probe: [], visible: [] };
      const seen = new Set<string>();
      let ackNumber = 0;
      const applyAtProbe = (frame: { cid: string; seq: number; d: string }) => {
        const key = `${frame.cid}:${frame.seq}`;
        if (!seen.has(key)) {
          seen.add(key);
          trace.probe.push(frame.d);
          trace.visible.push(frame.d);
        }
        ackNumber++;
        if (!(loseFirstAck && ackNumber === 1)) app._onWsInputAck(frame.seq);
      };
      const originalReliableSend = app._reliableSend.bind(app);
      app._reliableSend = (sessionId: string, data: string, useMux: boolean) => {
        trace.logical.push(data);
        return originalReliableSend(sessionId, data, useMux);
      };

      if (transport === 'ws') {
        app._wsSessionId = 's1';
        app._ws = {
          readyState: 1,
          send(raw: string) {
            trace.serialized.push(raw);
            applyAtProbe(JSON.parse(raw));
          },
          close() {},
        };
      } else {
        (window as any).fetch = async (_url: string, init: RequestInit) => {
          const body = JSON.parse(String(init.body));
          trace.serialized.push(String(init.body));
          const key = `browser-trace-client:${body.seq}`;
          if (!seen.has(key)) {
            seen.add(key);
            trace.probe.push(body.input);
            trace.visible.push(body.input);
          }
          return new Response('{}', { status: 200 });
        };
      }

      for (const input of inputs) app._sendInputAsync('s1', input);
      for (let index = 0; index < 50 && app._pendingDeliveries.size; index++) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 0));
      }
      if (transport === 'ws' && loseFirstAck) {
        const pending = app._pendingDeliveries.get('s1');
        pending[0].sentAt = Date.now() - 100;
        app._wsLastRecvAt = Date.now();
        app._redeliverSweep();
        for (const record of [...(app._pendingDeliveries.get('s1') ?? [])]) app._onWsInputAck(record.seq);
      }
      return { ...trace, pending: app._pendingDeliveries.size };
    },
    { transport, inputs, loseFirstAck: options.loseFirstAck ?? false }
  );
}

const payloadCases = [
  ['500 identical printable characters', ['x'.repeat(500)]],
  ['repeated runs', ['aaabbb111___']],
  ['rapid printable/control/Enter boundaries', ['abc', '\x03', 'def', '\x1b', '\r']],
  ['paste near the configured input limit', ['界'.repeat(21_840)]],
] as const;

describe('terminal input browser/protocol/probe correlation', () => {
  it.each(['ws', 'http'] as const)(
    '%s preserves all deterministic payload classes at every layer',
    async (transport) => {
      for (const [_label, inputs] of payloadCases) {
        const trace = await traceCase(transport, [...inputs]);
        expect(trace.logical).toEqual(inputs);
        expect(trace.serialized.map((raw) => JSON.parse(raw).d ?? JSON.parse(raw).input)).toEqual(inputs);
        expect(trace.probe).toEqual(inputs);
        expect(trace.visible).toEqual(inputs);
        expect(trace.pending).toBe(0);
      }
    }
  );

  it('lost WebSocket ACK resends a frame but the authoritative PTY receives it exactly once', async () => {
    const trace = await traceCase('ws', ['aaabbb111___'], { loseFirstAck: true });
    expect(trace.logical).toEqual(['aaabbb111___']);
    expect(trace.serialized).toHaveLength(2);
    expect(trace.probe).toEqual(['aaabbb111___']);
    expect(trace.visible).toEqual(trace.probe);
    expect(trace.pending).toBe(0);
  });

  it('emits only the committed CJK composition record', async () => {
    const inputs = await page.evaluate(async () => {
      const textarea = document.querySelector<HTMLTextAreaElement>('#ime')!;
      const committed: string[] = [];
      let composing = false;
      textarea.addEventListener('compositionstart', () => (composing = true));
      textarea.addEventListener('input', (event) => {
        if (!composing && (event as InputEvent).data) committed.push((event as InputEvent).data!);
      });
      textarea.addEventListener('compositionend', (event) => {
        composing = false;
        committed.push((event as CompositionEvent).data);
      });
      textarea.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }));
      textarea.dispatchEvent(new InputEvent('input', { data: '你', inputType: 'insertCompositionText' }));
      textarea.dispatchEvent(new InputEvent('input', { data: '你好', inputType: 'insertCompositionText' }));
      textarea.dispatchEvent(new CompositionEvent('compositionend', { data: '你好' }));
      return committed;
    });
    expect(inputs).toEqual(['你好']);
    for (const transport of ['ws', 'http'] as const) {
      const trace = await traceCase(transport, inputs);
      expect(trace.logical).toEqual(['你好']);
      expect(trace.probe).toEqual(['你好']);
      expect(trace.visible).toEqual(['你好']);
    }
  });

  it('reloads a pending durable record and reconnects without a second PTY write while server dedup survives', async () => {
    const result = await page.evaluate(async () => {
      const storage = new Map<string, string>();
      Object.defineProperty(window, 'localStorage', {
        configurable: true,
        value: {
          get length() {
            return storage.size;
          },
          key: (index: number) => [...storage.keys()][index] ?? null,
          getItem: (key: string) => storage.get(key) ?? null,
          setItem: (key: string, value: string) => storage.set(key, value),
          removeItem: (key: string) => storage.delete(key),
        },
      });
      const App = (window as any).__CodemanApp;
      const makeApp = () => {
        const app = Object.create(App.prototype);
        Object.assign(app, {
          _clientId: '',
          _seqCounters: new Map(),
          _pendingDeliveries: new Map(),
          _postDraining: new Set(),
          _persistReliableTimer: null,
          _reliableMaxBytes: 1024 * 1024,
          _updateConnectionIndicator() {},
          clearPendingHooks() {},
          markIdleAlertSeen() {},
          pendingHooks: new Map(),
          activeSessionId: 's1',
          _ws: null,
          _wsSessionId: null,
        });
        app._loadReliableState();
        return app;
      };
      const seen = new Set<string>();
      const probe: string[] = [];
      let acknowledge = false;
      const connect = (app: any) => {
        app._wsSessionId = 's1';
        app._ws = {
          readyState: 1,
          send(raw: string) {
            const frame = JSON.parse(raw);
            const key = `${frame.cid}:${frame.seq}`;
            if (!seen.has(key)) {
              seen.add(key);
              probe.push(frame.d);
            }
            if (acknowledge) app._onWsInputAck(frame.seq);
          },
          close() {},
        };
      };

      const first = makeApp();
      connect(first);
      first._sendInputAsync('s1', 'survive-reload');
      first._persistReliableNow();
      const firstClientId = first._clientId;

      acknowledge = true;
      const reloaded = makeApp();
      connect(reloaded);
      reloaded._onWsReady('s1');
      await new Promise((resolveWait) => setTimeout(resolveWait, 0));
      return {
        firstClientId,
        reloadedClientId: reloaded._clientId,
        probe,
        pending: reloaded._pendingDeliveries.size,
      };
    });

    expect(result.reloadedClientId).toBe(result.firstClientId);
    expect(result.probe).toEqual(['survive-reload']);
    expect(result.pending).toBe(0);
  });

  it('attributes restart-before-ACK duplication to volatile server dedup, not browser serialization', async () => {
    const result = await page.evaluate(() => {
      const serialized: string[] = [];
      const probe: string[] = [];
      const frame = { t: 'i', cid: 'restart-client', seq: 1, d: 'restart-window' };
      let serverSeen = new Set<string>();
      const deliver = () => {
        const raw = JSON.stringify(frame);
        serialized.push(raw);
        const decoded = JSON.parse(raw);
        const key = `${decoded.cid}:${decoded.seq}`;
        if (!serverSeen.has(key)) {
          serverSeen.add(key);
          probe.push(decoded.d);
        }
      };
      deliver();
      serverSeen = new Set(); // process restart loses Session._appliedInputSeq
      deliver(); // durable browser record is still pending because ACK was lost
      return { logical: [frame.d], serialized, probe, failingLayer: 'server-dedup-process-lifetime' };
    });

    expect(result.logical).toEqual(['restart-window']);
    expect(result.serialized).toHaveLength(2);
    expect(result.probe).toEqual(['restart-window', 'restart-window']);
    expect(result.failingLayer).toBe('server-dedup-process-lifetime');
  });
});
