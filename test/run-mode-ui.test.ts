/**
 * @fileoverview Unit tests for the Codex run-mode UI surface in session-ui.js /
 * settings-ui.js / index.html. Loads the browser modules into a vm sandbox (no
 * real DOM) and exercises run-mode selection + Codex quick-start wiring.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

function loadRunModeHarness() {
  const elements: Record<string, any> = {};
  const storage = new Map<string, string>();
  const CodemanApp = function CodemanApp(this: any) {};

  const context = vm.createContext({
    CodemanApp,
    VoiceInput: {},
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
    document: {
      getElementById: (id: string) => elements[id] ?? null,
    },
    console,
  });

  const settingsUi = readFileSync(resolve(import.meta.dirname, '../src/web/public/settings-ui.js'), 'utf8');
  const sessionUi = readFileSync(resolve(import.meta.dirname, '../src/web/public/session-ui.js'), 'utf8');
  vm.runInContext(settingsUi, context, { filename: 'settings-ui.js' });
  vm.runInContext(sessionUi, context, { filename: 'session-ui.js' });

  const runModeMenu = { classList: { remove: () => {} } };
  const gearBtn = { className: '' };
  const runBtn = { className: '', nextElementSibling: gearBtn };
  const runBtnLabel = { textContent: '' };
  elements.runModeMenu = runModeMenu;
  elements.runBtn = runBtn;
  elements.runBtnLabel = runBtnLabel;

  const app = new (CodemanApp as any)();
  app.loadAppSettingsFromStorage = () => ({});
  app.saveAppSettingsToStorage = () => {};
  app._apiPut = () => Promise.resolve();

  return { app, storage, runBtnLabel };
}

describe('run mode UI', () => {
  it('updates the visible mode when selecting Claude after server sync set Codex', async () => {
    const { app, storage, runBtnLabel } = loadRunModeHarness();

    storage.set('codeman_runMode', 'claude');
    await app.loadAppSettingsFromServer(Promise.resolve({ runMode: 'codex' }));
    expect(app.runMode).toBe('codex');
    expect(runBtnLabel.textContent).toBe('Run CX');

    app.setRunMode('claude');

    expect(app.runMode).toBe('claude');
    expect(runBtnLabel.textContent).toBe('Run');
  });

  it('accepts Gemini mode from server sync and updates the run button label', async () => {
    const { app, storage, runBtnLabel } = loadRunModeHarness();

    storage.set('codeman_runMode', 'claude');
    await app.loadAppSettingsFromServer(Promise.resolve({ runMode: 'gemini' }));

    expect(app.runMode).toBe('gemini');
    expect(runBtnLabel.textContent).toBe('Run GM');
  });
  it('passes global Codex settings into quick-start config for new sessions', async () => {
    const elements: Record<string, any> = {
      quickStartCase: { value: 'codex-case' },
    };
    const requests: Array<{ url: string; body?: any }> = [];
    const CodemanApp = function CodemanApp(this: any) {};

    const context = vm.createContext({
      CodemanApp,
      localStorage: {
        getItem: () => null,
        setItem: () => {},
      },
      document: {
        getElementById: (id: string) => elements[id] ?? null,
      },
      // Mock responses use the real wire shape: the global preSerialization hook in
      // server.ts wraps route payloads into the { success, data } envelope.
      fetch: async (url: string, init?: { body?: string }) => {
        requests.push({ url, body: init?.body ? JSON.parse(init.body) : undefined });
        if (url === '/api/codex/status') return { json: async () => ({ success: true, data: { available: true } }) };
        if (url === '/api/quick-start') return { json: async () => ({ success: true, data: { sessionId: 'sess-1' } }) };
        throw new Error(`unexpected fetch: ${url}`);
      },
      console,
    });

    const sessionUi = readFileSync(resolve(import.meta.dirname, '../src/web/public/session-ui.js'), 'utf8');
    vm.runInContext(sessionUi, context, { filename: 'session-ui.js' });

    const app = new (CodemanApp as any)();
    app.terminal = { clear: () => {}, writeln: () => {}, focus: () => {} };
    app.loadAppSettingsFromStorage = () => ({
      codexDangerouslyBypassApprovals: true,
    });
    app.getCaseSettings = () => ({});
    app.buildEnvOverrides = () => ({});
    app.selectSession = async () => {};

    await app.runCodex();

    expect(requests.find((req) => req.url === '/api/quick-start')?.body).toMatchObject({
      caseName: 'codex-case',
      mode: 'codex',
      codexConfig: { dangerouslyBypassApprovals: true, renderMode: 'hybrid' },
    });
  });
});

describe('case selector refresh', () => {
  it('creates remote shell sessions by caseName instead of remote display path', async () => {
    const elements: Record<string, any> = {
      quickStartCase: { value: 'gpu-work' },
      shellCount: { value: '1' },
    };
    const requests: Array<{ url: string; body?: any }> = [];
    const CodemanApp = function CodemanApp(this: any) {};

    const context = vm.createContext({
      CodemanApp,
      localStorage: {
        getItem: () => null,
        setItem: () => {},
      },
      document: {
        getElementById: (id: string) => elements[id] ?? null,
      },
      fetch: async (url: string, init?: { body?: string }) => {
        requests.push({ url, body: init?.body ? JSON.parse(init.body) : undefined });
        if (url === '/api/cases/gpu-work') {
          return {
            json: async () => ({
              success: true,
              data: {
                name: 'gpu-work',
                path: 'ubuntu@10.0.0.42:/home/ubuntu/work',
                location: 'remote',
                remote: { hostId: 'gpu-box', path: '/home/ubuntu/work' },
              },
            }),
          };
        }
        if (url === '/api/sessions') {
          return { json: async () => ({ success: true, data: { session: { id: 'sess-1' } } }) };
        }
        if (url === '/api/sessions/sess-1/shell') return { json: async () => ({ success: true }) };
        throw new Error(`unexpected fetch: ${url}`);
      },
      console,
    });

    const sessionUi = readFileSync(resolve(import.meta.dirname, '../src/web/public/session-ui.js'), 'utf8');
    vm.runInContext(sessionUi, context, { filename: 'session-ui.js' });

    const app = new (CodemanApp as any)();
    app.terminal = { clear: () => {}, writeln: () => {}, focus: () => {} };
    app.sessions = new Map();
    app.cases = [{ name: 'gpu-work', path: 'ubuntu@10.0.0.42:/home/ubuntu/work', location: 'remote' }];
    app.getTerminalDimensions = () => null;
    app.selectSession = async () => {};

    await app.runShell();

    expect(requests.find((req) => req.url === '/api/sessions')?.body).toMatchObject({
      caseName: 'gpu-work',
      mode: 'shell',
    });
    expect(requests.find((req) => req.url === '/api/sessions')?.body).not.toHaveProperty('workingDir');
  });

  it('removes a deleted selected case from the dropdown and blurs the native picker', async () => {
    const elements: Record<string, any> = {};
    const requests: Array<{ url: string; method: string; body?: any }> = [];
    const CodemanApp = function CodemanApp(this: any) {};
    const quickStartCase = {
      value: 'deleted-case',
      innerHTML: '<option value="deleted-case">deleted-case</option><option value="kept-case">kept-case</option>',
      dataset: {},
      blur: vi.fn(),
      addEventListener: vi.fn(),
    };

    elements.quickStartCase = quickStartCase;
    elements.caseManageList = { innerHTML: '' };
    elements.mobileCaseName = { textContent: '' };
    elements.dirDisplay = { textContent: '' };
    elements.dirInput = { value: '' };

    const context = vm.createContext({
      CodemanApp,
      MobileDetection: { getDeviceType: () => 'desktop' },
      localStorage: {
        getItem: () => null,
        setItem: () => {},
      },
      document: {
        getElementById: (id: string) => elements[id] ?? null,
      },
      confirm: () => true,
      fetch: async (url: string, init?: { method?: string; body?: string }) => {
        requests.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body) : undefined });
        if (url === '/api/cases/deleted-case')
          return { json: async () => ({ success: true, data: { name: 'deleted-case' } }) };
        // The server's preSerialization hook wraps bare payloads as { success, data },
        // so the frontend reads `.data` off every JSON response — mirror that here.
        if (url === '/api/settings')
          return { ok: true, json: async () => ({ success: true, data: { lastUsedCase: 'deleted-case' } }) };
        if (url === '/api/cases')
          return { json: async () => ({ success: true, data: [{ name: 'kept-case', path: '/tmp/kept-case' }] }) };
        if (url === '/api/cases/kept-case')
          return { json: async () => ({ success: true, data: { path: '/tmp/kept-case' } }) };
        if (url === '/api/settings' && init?.method === 'PUT') return { json: async () => ({ success: true }) };
        throw new Error(`unexpected fetch: ${url}`);
      },
      console,
      escapeHtml: (s: string) => s,
    });

    const sessionUi = readFileSync(resolve(import.meta.dirname, '../src/web/public/session-ui.js'), 'utf8');
    vm.runInContext(sessionUi, context, { filename: 'session-ui.js' });

    const app = new (CodemanApp as any)();
    app.cases = [
      { name: 'deleted-case', path: '/tmp/deleted-case' },
      { name: 'kept-case', path: '/tmp/kept-case' },
    ];
    app.showToast = vi.fn();

    await app.deleteCase('deleted-case');

    expect(quickStartCase.blur).toHaveBeenCalled();
    expect(quickStartCase.innerHTML).not.toContain('deleted-case');
    expect(quickStartCase.innerHTML).toContain('kept-case');
    expect(elements.mobileCaseName.textContent).toBe('kept-case');
    expect(requests).toContainEqual({
      url: '/api/settings',
      method: 'PUT',
      body: { lastUsedCase: 'kept-case' },
    });
  });
});

describe('case edit UI', () => {
  it('prefills and saves remote case parameters from the Manage tab edit action', async () => {
    const elements: Record<string, any> = {};
    const requests: Array<{ url: string; method: string; body?: any }> = [];
    const CodemanApp = function CodemanApp(this: any) {};
    const modalTabs = ['case-create', 'case-link', 'case-remote', 'case-manage'].map((tab) => ({
      dataset: { tab },
      classList: { toggle: vi.fn() },
    }));
    const modalContents = modalTabs.map((tab) => ({ id: tab.dataset.tab, classList: { toggle: vi.fn() } }));

    elements.createCaseModal = {
      classList: { add: vi.fn(), remove: vi.fn() },
      querySelectorAll: (selector: string) => {
        if (selector === '.modal-tabs .modal-tab-btn') return modalTabs;
        if (selector === '.modal-tab-content') return modalContents;
        if (selector === 'input[type="text"]') return [];
        return [];
      },
    };
    elements.caseModalTitle = { textContent: '' };
    elements.caseModalSubmit = { textContent: '', style: {}, classList: { add: vi.fn(), remove: vi.fn() } };
    elements.remoteDiscoverSection = { classList: { add: vi.fn(), remove: vi.fn() } };
    elements.caseManageList = { innerHTML: '' };
    elements.quickStartCase = { value: 'gpu-work' };
    elements.mobileCaseName = { textContent: '' };
    elements.dirDisplay = { textContent: '' };
    elements.dirInput = { value: '' };

    for (const id of [
      'newCaseName',
      'newCaseDescription',
      'linkCaseName',
      'linkCasePath',
      'remoteCaseName',
      'remoteCasePath',
      'remoteHostId',
      'remoteHostAddress',
      'remoteHostUsername',
      'remoteHostPort',
      'remoteHostCodexCommand',
      'remoteHostIdentityFile',
      'remoteHostSocksProxy',
      'remoteHostJumpHost',
      'remoteHostExtraSshOptions',
    ]) {
      elements[id] = { value: '', focus: vi.fn(), addEventListener: vi.fn() };
    }

    const context = vm.createContext({
      CodemanApp,
      localStorage: { getItem: () => null, setItem: () => {} },
      document: { getElementById: (id: string) => elements[id] ?? null },
      fetch: async (url: string, init?: { method?: string; body?: string }) => {
        requests.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body) : undefined });
        if (url === '/api/remote-hosts') {
          return {
            json: async () => ({
              success: true,
              data: [
                {
                  id: 'gpu-box',
                  label: 'GPU Box',
                  host: '10.0.0.42',
                  username: 'ubuntu',
                  port: 2222,
                  identityFile: '~/.ssh/gpu',
                  socksProxy: '127.0.0.1:1080',
                  jumpHost: 'bastion',
                  extraSshOptions: ['StrictHostKeyChecking=accept-new'],
                  commands: { codex: 'exec codx personal' },
                },
              ],
            }),
          };
        }
        if (url === '/api/remote-hosts/gpu-box' && init?.method === 'PUT')
          return { json: async () => ({ success: true }) };
        if (url === '/api/cases/gpu-work' && init?.method === 'PUT') {
          return {
            json: async () => ({
              success: true,
              data: {
                case: {
                  name: 'gpu-renamed',
                  path: 'ubuntu@10.0.0.42:/home/ubuntu/new-work',
                  location: 'remote',
                  remote: { hostId: 'gpu-box', path: '/home/ubuntu/new-work' },
                },
              },
            }),
          };
        }
        if (url === '/api/cases') return { json: async () => ({ success: true, data: [] }) };
        throw new Error(`unexpected fetch: ${url}`);
      },
      console,
      escapeHtml: (s: string) => s,
    });

    const sessionUi = readFileSync(resolve(import.meta.dirname, '../src/web/public/session-ui.js'), 'utf8');
    vm.runInContext(sessionUi, context, { filename: 'session-ui.js' });

    const app = new (CodemanApp as any)();
    app.cases = [
      {
        name: 'gpu-work',
        path: 'ubuntu@10.0.0.42:/home/ubuntu/work',
        location: 'remote',
        remote: { hostId: 'gpu-box', host: '10.0.0.42', username: 'ubuntu', path: '/home/ubuntu/work' },
      },
    ];
    app.showToast = vi.fn();
    app.loadQuickStartCases = vi.fn(async () => {});
    app.saveLastUsedCase = vi.fn(async () => {});

    await app.editCase('gpu-work');

    expect(elements.remoteCaseName.value).toBe('gpu-work');
    expect(elements.remoteCasePath.value).toBe('/home/ubuntu/work');
    expect(elements.remoteHostPort.value).toBe('2222');
    expect(elements.remoteHostCodexCommand.value).toBe('exec codx personal');
    expect(elements.remoteHostExtraSshOptions.value).toBe('StrictHostKeyChecking=accept-new');

    elements.remoteCaseName.value = 'gpu-renamed';
    elements.remoteCasePath.value = '/home/ubuntu/new-work';
    await app.submitCaseModal();

    expect(requests).toContainEqual({
      url: '/api/remote-hosts/gpu-box',
      method: 'PUT',
      body: expect.objectContaining({
        id: 'gpu-box',
        host: '10.0.0.42',
        port: 2222,
        commands: { codex: 'exec codx personal' },
      }),
    });
    expect(requests).toContainEqual({
      url: '/api/cases/gpu-work',
      method: 'PUT',
      body: { name: 'gpu-renamed', hostId: 'gpu-box', remotePath: '/home/ubuntu/new-work' },
    });
  });
});
