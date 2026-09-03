import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

type Listener = (event: { preventDefault: () => void; stopPropagation: () => void }) => void | Promise<void>;

class FakeElement {
  children: FakeElement[] = [];
  dataset: Record<string, string> = {};
  className = '';
  textContent = '';
  title = '';
  disabled = false;
  value = '';
  listeners: Record<string, Listener[]> = {};
  classList = { add: vi.fn(), remove: vi.fn(), toggle: vi.fn() };

  appendChild(child: FakeElement) {
    this.children.push(child);
    return child;
  }

  append(...children: FakeElement[]) {
    children.forEach((child) => this.appendChild(child));
  }

  replaceChildren(...children: FakeElement[]) {
    this.children = children;
  }

  addEventListener(type: string, listener: Listener) {
    (this.listeners[type] ||= []).push(listener);
  }

  async click() {
    for (const listener of this.listeners.click || []) {
      await listener({ preventDefault: vi.fn(), stopPropagation: vi.fn() });
    }
  }

  setAttribute() {}
  removeAttribute() {}
  focus() {}
}

function loadHarness(fetchImpl: (url: string, init?: RequestInit) => Promise<any>) {
  const elements: Record<string, FakeElement> = {
    sessionManagerModal: new FakeElement(),
    sessionManagerSearch: new FakeElement(),
    sessionManagerList: new FakeElement(),
    sessionRecoveryList: new FakeElement(),
  };
  const CodemanApp = function CodemanApp(this: any) {};
  const context = vm.createContext({
    CodemanApp,
    document: {
      getElementById: (id: string) => elements[id] || null,
      createElement: () => new FakeElement(),
    },
    fetch: vi.fn(fetchImpl),
    confirm: vi.fn(() => true),
    navigator: { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } },
    console,
    escapeHtml: (value: string) => String(value),
  });
  const source = readFileSync(resolve(import.meta.dirname, '../src/web/public/panels-ui.js'), 'utf8');
  vm.runInContext(source, context, { filename: 'panels-ui.js' });
  const app = new (CodemanApp as any)();
  app.sessions = new Map([['live-1', { id: 'live-1' }]]);
  app.cases = [];
  app._buildHistoryItem = vi.fn(() => new FakeElement());
  app.selectSession = vi.fn().mockResolvedValue(undefined);
  app.closeSessionManager = vi.fn();
  app.showToast = vi.fn();
  app._debouncedCall = vi.fn((_key: string, callback: () => void) => callback());
  return {
    app,
    elements,
    fetch: context.fetch as ReturnType<typeof vi.fn>,
    confirm: context.confirm as ReturnType<typeof vi.fn>,
  };
}

const ok = (data: unknown) => ({ ok: true, status: 200, json: async () => data });

const resumableCodex = {
  id: 'lost-codex',
  sourceSessionId: 'old-codex',
  mode: 'codex',
  workingDir: '/repo/codex',
  transport: 'local',
  nativeResumeId: 'rollout-123',
  status: 'resumable',
  launch: { kind: 'built-in' },
  createdAt: 1,
};

describe('Session Manager Recovery Queue', () => {
  it('renders recovery records separately from live and history rows', async () => {
    const { app, elements, fetch } = loadHarness(async (url) => {
      if (url.startsWith('/api/sessions/unified')) {
        return ok({ success: true, data: { sessions: [{ sessionId: 'live-1', workingDir: '/repo/live' }] } });
      }
      if (url === '/api/session-recoveries') return ok({ recoveries: [resumableCodex] });
      throw new Error(`unexpected request ${url}`);
    });

    await app._loadSessionManagerList('');

    expect(fetch).toHaveBeenCalledWith('/api/session-recoveries');
    expect(elements.sessionRecoveryList.children).toHaveLength(1);
    expect(elements.sessionRecoveryList.children[0].dataset.recoveryId).toBe('lost-codex');
    expect(elements.sessionManagerList.children).toHaveLength(1);
    expect(app._buildHistoryItem).toHaveBeenCalledTimes(1);
    expect(app.sessions.has('lost-codex')).toBe(false);
  });

  it('does not recover merely by opening the manager', async () => {
    const { app, fetch } = loadHarness(async (url) => {
      if (url === '/api/cases') return ok({ data: [] });
      if (url.startsWith('/api/sessions/unified')) return ok({ success: true, data: { sessions: [] } });
      if (url === '/api/session-recoveries') return ok({ recoveries: [resumableCodex] });
      throw new Error(`unexpected request ${url}`);
    });

    await app.openSessionManager();

    expect(fetch.mock.calls.map(([url]) => url)).not.toContain('/api/session-recoveries/lost-codex/resume');
    expect(fetch.mock.calls.map(([url]) => url)).not.toContain('/api/session-recoveries/lost-codex/reconnect');
  });

  it('confirms the original location, resumes, refreshes, and selects only the returned session', async () => {
    let listLoads = 0;
    const { app, elements, fetch, confirm } = loadHarness(async (url, init) => {
      if (url.startsWith('/api/sessions/unified')) return ok({ success: true, data: { sessions: [] } });
      if (url === '/api/session-recoveries') {
        listLoads += 1;
        return ok({ recoveries: listLoads === 1 ? [resumableCodex] : [] });
      }
      if (url === '/api/session-recoveries/lost-codex/resume') {
        expect(init).toMatchObject({ method: 'POST' });
        return ok({ session: { id: 'replacement-codex' } });
      }
      throw new Error(`unexpected request ${url}`);
    });

    await app._loadSessionManagerList('');
    const action = elements.sessionRecoveryList.children[0].children.at(-1)!.children[0];
    await action.click();

    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('/repo/codex'));
    expect(fetch).toHaveBeenCalledWith(
      '/api/session-recoveries/lost-codex/resume',
      expect.objectContaining({ method: 'POST' })
    );
    expect(app.selectSession).toHaveBeenCalledWith('replacement-codex');
    expect(app.sessions.has('lost-codex')).toBe(false);
  });

  it('maps manual and unavailable recoveries to copy hint and Start new without a resume action', async () => {
    const manual = {
      ...resumableCodex,
      id: 'manual',
      status: 'manual_required',
      launch: { kind: 'manual_required', hint: 'Start safely' },
    };
    const unavailable = { ...resumableCodex, id: 'fresh', status: 'unavailable', nativeResumeId: undefined };
    const { app, elements } = loadHarness(async (url) => {
      if (url.startsWith('/api/sessions/unified')) return ok({ success: true, data: { sessions: [] } });
      if (url === '/api/session-recoveries') return ok({ recoveries: [manual, unavailable] });
      throw new Error(`unexpected request ${url}`);
    });

    await app._loadSessionManagerList('');

    expect(elements.sessionRecoveryList.children.map((row) => row.children.at(-1)?.children[0]?.textContent)).toEqual([
      'Copy hint',
      'Start new',
    ]);
  });
});
