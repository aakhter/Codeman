import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StateStore } from '../src/state-store.js';
import { snapshotDeadSessionRecoveries, planAutomaticRecovery } from '../src/session-recovery.js';
import type { SessionState } from '../src/types/session.js';
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

  it('shows conversation and tab names separately with a clear unavailable status', async () => {
    const record = { ...resumableCodex, name: 'w3-kb', conversationName: 'Review architecture', status: 'unavailable' };
    const { app, elements } = loadHarness(async (url) =>
      url === '/api/session-recoveries' ? ok({ recoveries: [record] }) : ok({ success: true, data: { sessions: [] } })
    );
    await app._loadSessionManagerList('');
    const details = elements.sessionRecoveryList.children[0].children[0].children.map((child) => child.textContent);
    expect(details).toContain('Session name: Review architecture');
    expect(details).toContain('Codeman tab: w3-kb');
    expect(details).toContain('Needs recovery check');
  });

  it.each(['codex', 'claude'] as const)(
    'retains historical %s evidence through pruning, store restart, decision and UI',
    async (mode) => {
      const root = mkdtempSync(join(tmpdir(), 'recovery-trace-'));
      try {
        const id = '01a0c810-a5c4-7b32-be0b-1599d9d5995d';
        const source = {
          id: 'pane',
          mode,
          workingDir: '/work/project',
          name: 'w4-work',
          pid: null,
          status: 'idle',
          currentTaskId: null,
          createdAt: 1000,
          lastActivityAt: 2000,
          ...(mode === 'codex' ? { codexConfig: { resumeSessionId: id } } : { claudeSessionChain: ['old', id] }),
        } as SessionState;
        const path = join(root, 'state.json');
        const before = new StateStore(path);
        before.setSession(source.id, source);
        await snapshotDeadSessionRecoveries(before, [source.id], new Map());
        before.removeSession(source.id);
        before.saveNow();
        const after = new StateStore(path);
        const [record] = after.getSessionRecoveries();
        expect(record).toMatchObject({
          sourceSessionId: 'pane',
          mode,
          workingDir: '/work/project',
          name: 'w4-work',
          createdAt: 1000,
          lastActivityAt: 2000,
        });
        expect(mode === 'codex' ? record.nativeResumeId : record.claudeResumeId).toBe(id);
        expect(planAutomaticRecovery(record, false)).toBe('resume');
        expect(record.restoreEvidence).toBeUndefined();
        const { app, elements } = loadHarness(async () => ok({}));
        app._renderSessionRecoveryList(elements.sessionRecoveryList, [record]);
        const texts = elements.sessionRecoveryList.children[0].children[0].children.map((c) => c.textContent);
        expect(texts).toContain(`Conversation ID: ${id}`);
        expect(texts).toContain('Codeman tab: w4-work');
        expect(texts).toContain(`${mode} · local · /work/project`);
        expect(texts).toContain('Saved resume ID; availability not checked');
        expect(texts).toContain('Created: 1970-01-01T00:00:01.000Z · Last recorded activity: 1970-01-01T00:00:02.000Z');
        expect(elements.sessionRecoveryList.children[0].children[1].children.map((c) => c.textContent)).toEqual([
          'Resume',
          'Refresh',
          'Dismiss',
        ]);
        before.flush();
        after.flush();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  );

  it('distinguishes metadata found from a conversation restore confirmed by the CLI', () => {
    const { app, elements } = loadHarness(async () => ok({}));
    app._renderSessionRecoveryList(elements.sessionRecoveryList, [
      { ...resumableCodex, lastCheckedAt: 1 },
      { ...resumableCodex, status: 'recovered', restoreEvidence: 'launch_returned' },
    ]);
    expect(elements.sessionRecoveryList.children[0].children[0].children.map((c) => c.textContent)).toContain(
      'Conversation metadata found; resume not confirmed'
    );
    expect(elements.sessionRecoveryList.children[1].children[0].children.map((c) => c.textContent)).toContain(
      'Session launch returned; conversation restore not confirmed'
    );
  });

  it('offers Refresh for an unavailable local Claude recovery', async () => {
    const { app, elements } = loadHarness(async (url) =>
      url === '/api/session-recoveries'
        ? ok({ recoveries: [{ ...resumableCodex, mode: 'claude', status: 'unavailable' }] })
        : ok({ success: true, data: { sessions: [] } })
    );
    await app._loadSessionManagerList('');
    expect(
      elements.sessionRecoveryList.children[0].children.at(-1)?.children.map((child) => child.textContent)
    ).toEqual(['Start new', 'Refresh', 'Dismiss']);
  });

  it('renders the recovery queue before a slow unified history request finishes', async () => {
    let resolveHistory: (value: ReturnType<typeof ok>) => void;
    const history = new Promise<ReturnType<typeof ok>>((resolve) => {
      resolveHistory = resolve;
    });
    const { app, elements } = loadHarness(async (url) =>
      url === '/api/session-recoveries' ? ok({ recoveries: [resumableCodex] }) : history
    );
    const loading = app._loadSessionManagerList('');
    await vi.waitFor(() => expect(elements.sessionRecoveryList.children[0]?.dataset.recoveryId).toBe('lost-codex'), {
      timeout: 100,
    });
    resolveHistory!(ok({ success: true, data: { sessions: [] } }));
    await loading;
  });

  it('renders recovery records from the session-recoveries success envelope', async () => {
    const { app, elements } = loadHarness(async (url) => {
      if (url.startsWith('/api/sessions/unified')) {
        return ok({ success: true, data: { sessions: [] } });
      }
      if (url === '/api/session-recoveries') {
        return ok({ success: true, data: { recoveries: [resumableCodex] } });
      }
      throw new Error(`unexpected request ${url}`);
    });

    await app._loadSessionManagerList('');

    expect(elements.sessionRecoveryList.children).toHaveLength(1);
    expect(elements.sessionRecoveryList.children[0].dataset.recoveryId).toBe('lost-codex');
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

  it('keeps unified live and history rows when the recovery queue request rejects', async () => {
    const { app, elements } = loadHarness(async (url) => {
      if (url.startsWith('/api/sessions/unified')) {
        return ok({ success: true, data: { sessions: [{ sessionId: 'live-1', workingDir: '/repo/live' }] } });
      }
      if (url === '/api/session-recoveries') throw new Error('recovery network unavailable');
      throw new Error(`unexpected request ${url}`);
    });

    await app._loadSessionManagerList('');

    expect(app._buildHistoryItem).toHaveBeenCalledTimes(1);
    expect(elements.sessionManagerList.children).toHaveLength(1);
    expect(elements.sessionManagerList.children[0].textContent).not.toBe('Failed to load sessions');
    expect(elements.sessionRecoveryList.children).toHaveLength(1);
    expect(elements.sessionRecoveryList.children[0].textContent).toBe('Recovery Queue is unavailable');
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
    expect(
      elements.sessionRecoveryList.children[1].children.at(-1)?.children.map((button) => button.textContent)
    ).toEqual(['Start new', 'Refresh', 'Dismiss']);
  });

  it('lets a user dismiss a recovered record after its replacement session exists', async () => {
    let recoveryLoads = 0;
    const recovered = { ...resumableCodex, status: 'recovered', recoveredSessionId: 'replacement-codex' };
    const { app, elements, fetch, confirm } = loadHarness(async (url, init) => {
      if (url.startsWith('/api/sessions/unified')) return ok({ success: true, data: { sessions: [] } });
      if (url === '/api/session-recoveries') return ok({ recoveries: recoveryLoads++ === 0 ? [recovered] : [] });
      if (url === '/api/session-recoveries/lost-codex/dismiss') {
        expect(init).toMatchObject({ method: 'POST' });
        return ok({ dismissed: true });
      }
      throw new Error(`unexpected request ${url}`);
    });

    await app._loadSessionManagerList('');
    const dismiss = elements.sessionRecoveryList.children[0].children.at(-1)!.children[0];
    expect(dismiss.textContent).toBe('Dismiss');
    await dismiss.click();

    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('/repo/codex'));
    expect(fetch).toHaveBeenCalledWith(
      '/api/session-recoveries/lost-codex/dismiss',
      expect.objectContaining({ method: 'POST' })
    );
    expect(recoveryLoads).toBe(2);
    expect(elements.sessionRecoveryList.children).toHaveLength(0);
    expect(app.sessions.has('lost-codex')).toBe(false);
    expect(app.selectSession).not.toHaveBeenCalled();
  });
});
