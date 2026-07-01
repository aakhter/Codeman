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
  it('sorts case picker options alphabetically and filters by case or host label', () => {
    const CodemanApp = function CodemanApp(this: any) {};
    const context = vm.createContext({
      CodemanApp,
      localStorage: { getItem: () => null, setItem: () => {} },
      document: { getElementById: () => null },
      console,
    });

    const sessionUi = readFileSync(resolve(import.meta.dirname, '../src/web/public/session-ui.js'), 'utf8');
    vm.runInContext(sessionUi, context, { filename: 'session-ui.js' });

    const app = new (CodemanApp as any)();
    const cases = [
      { name: 'zeta' },
      { name: 'moneytrove', location: 'remote', remote: { hostId: 'mac-mini', path: '/Users/saqeb/moneytrove' } },
      { name: 'Alpha' },
      { name: 'plex-previews' },
    ];

    const options = app.buildCasePickerOptions(cases);

    expect(options.map((option: any) => option.name)).toEqual([
      'Alpha',
      'moneytrove',
      'plex-previews',
      'testcase',
      'zeta',
    ]);
    expect(options.find((option: any) => option.name === 'moneytrove')?.label).toBe('moneytrove @ mac-mini');
    expect(app.filterCasePickerOptions(options, 'MAC').map((option: any) => option.name)).toEqual(['moneytrove']);
    expect(app.filterCasePickerOptions(options, 'plex').map((option: any) => option.name)).toEqual(['plex-previews']);
  });

  it('launches the highlighted case with the current run mode when pressing Enter in the picker', () => {
    const elements: Record<string, any> = {};
    const listeners: Record<string, (event: any) => void> = {};
    const CodemanApp = function CodemanApp(this: any) {};

    elements.quickStartCase = {
      value: 'Alpha',
      dataset: {},
    };
    elements.quickStartCaseSearch = {
      value: 'mon',
      dataset: {},
      setAttribute: vi.fn(),
      removeAttribute: vi.fn(),
      addEventListener: vi.fn((event: string, handler: (event: any) => void) => {
        listeners[event] = handler;
      }),
      select: vi.fn(),
    };
    elements.quickStartCaseList = {
      innerHTML: '',
      classList: { add: vi.fn(), remove: vi.fn() },
      addEventListener: vi.fn(),
    };
    elements.quickStartCasePicker = {
      contains: () => true,
    };

    const context = vm.createContext({
      CodemanApp,
      localStorage: { getItem: () => null, setItem: () => {} },
      document: {
        getElementById: (id: string) => elements[id] ?? null,
        addEventListener: vi.fn(),
      },
      console,
      escapeHtml: (s: string) => s,
    });

    const sessionUi = readFileSync(resolve(import.meta.dirname, '../src/web/public/session-ui.js'), 'utf8');
    vm.runInContext(sessionUi, context, { filename: 'session-ui.js' });

    const app = new (CodemanApp as any)();
    app.cases = [
      { name: 'Alpha' },
      { name: 'moneytrove', location: 'remote', remote: { hostId: 'mac-mini', path: '/Users/saqeb/moneytrove' } },
      { name: 'zeta' },
    ];
    app.updateDirDisplayForCase = vi.fn();
    app.updateMobileCaseLabel = vi.fn();
    app.saveLastUsedCase = vi.fn();
    app.run = vi.fn(async () => {});

    app.setupQuickStartCasePicker();
    listeners.keydown({ key: 'Enter', preventDefault: vi.fn() });

    expect(elements.quickStartCase.value).toBe('moneytrove');
    expect(app.run).toHaveBeenCalledTimes(1);
  });

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

describe('Gemini quick start', () => {
  // Regression guard for the ApiResponse-envelope unwrap in runGemini(): the
  // status check must read `.data.available` and the quick-start response must
  // read `.data.sessionId`. Reading the raw shape (pre-fix) silently bails on
  // the status check and never selects the new tab — exactly the two blockers
  // caught in PR #134 review.
  it('drives runGemini() through the {success,data} envelope and selects the new session', async () => {
    const elements: Record<string, any> = {
      quickStartCase: { value: 'gemini-case' },
    };
    const requests: Array<{ url: string; body?: any }> = [];
    const CodemanApp = function CodemanApp(this: any) {};

    const context = vm.createContext({
      CodemanApp,
      localStorage: { getItem: () => null, setItem: () => {} },
      document: { getElementById: (id: string) => elements[id] ?? null },
      // Mock responses use the real wire shape: the server.ts preSerialization
      // hook wraps raw route payloads into the { success, data } envelope.
      fetch: async (url: string, init?: { body?: string }) => {
        requests.push({ url, body: init?.body ? JSON.parse(init.body) : undefined });
        if (url === '/api/gemini/status') return { json: async () => ({ success: true, data: { available: true } }) };
        if (url === '/api/quick-start')
          return { json: async () => ({ success: true, data: { sessionId: 'sess-gm' } }) };
        throw new Error(`unexpected fetch: ${url}`);
      },
      console,
    });

    const sessionUi = readFileSync(resolve(import.meta.dirname, '../src/web/public/session-ui.js'), 'utf8');
    vm.runInContext(sessionUi, context, { filename: 'session-ui.js' });

    const app = new (CodemanApp as any)();
    app.terminal = { clear: () => {}, writeln: () => {}, focus: () => {} };
    app.loadAppSettingsFromStorage = () => ({});
    app.getCaseSettings = () => ({});
    app.buildEnvOverrides = () => ({});
    const selected: string[] = [];
    app.selectSession = async (id: string) => {
      selected.push(id);
    };

    await app.runGemini();

    expect(requests.find((req) => req.url === '/api/quick-start')?.body).toMatchObject({
      caseName: 'gemini-case',
      mode: 'gemini',
      geminiConfig: { approvalMode: 'yolo' },
    });
    expect(selected).toEqual(['sess-gm']);
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
      'remoteCaseCodexCommand',
      'remoteHostId',
      'remoteHostAddress',
      'remoteHostUsername',
      'remoteHostPort',
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
        if (url === '/api/remote-hosts' && init?.method === 'POST') {
          return { json: async () => ({ success: true }) };
        }
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
                  remote: { hostId: 'gpu-box', path: '/home/ubuntu/new-work', commands: { codex: 'exec case-codex' } },
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
        remote: {
          hostId: 'gpu-box',
          host: '10.0.0.42',
          username: 'ubuntu',
          path: '/home/ubuntu/work',
          commands: { codex: 'exec case-codex' },
        },
      },
    ];
    app.showToast = vi.fn();
    app.loadQuickStartCases = vi.fn(async () => {});
    app.saveLastUsedCase = vi.fn(async () => {});

    await app.editCase('gpu-work');

    expect(elements.remoteCaseName.value).toBe('gpu-work');
    expect(elements.remoteCasePath.value).toBe('/home/ubuntu/work');
    expect(elements.remoteCaseCodexCommand.value).toBe('exec case-codex');
    expect(elements.remoteHostPort.value).toBe('2222');
    expect(elements.remoteHostExtraSshOptions.value).toBe('StrictHostKeyChecking=accept-new');

    elements.remoteCaseName.value = 'gpu-renamed';
    elements.remoteCasePath.value = '/home/ubuntu/new-work';
    await app.submitCaseModal();

    expect(requests.some((req) => req.url === '/api/remote-hosts/gpu-box' && req.method === 'PUT')).toBe(false);
    expect(requests).toContainEqual({
      url: '/api/cases/gpu-work',
      method: 'PUT',
      body: {
        name: 'gpu-renamed',
        hostId: 'gpu-box',
        remotePath: '/home/ubuntu/new-work',
        commands: { codex: 'exec case-codex' },
      },
    });
  });
});

describe('case directory browser UI', () => {
  it('orders saved SSH configuration before remote directory selection', () => {
    const html = readFileSync(resolve(import.meta.dirname, '../src/web/public/index.html'), 'utf8');

    expect(html.indexOf('id="remoteHostSavedSelect"')).toBeGreaterThan(-1);
    expect(html.indexOf('id="remoteHostSavedEdit"')).toBeGreaterThan(-1);
    expect(html.indexOf('id="remoteHostSavedAdd"')).toBeGreaterThan(-1);
    expect(html.indexOf('id="remoteHostConfigModal"')).toBeGreaterThan(-1);
    expect(html.indexOf('id="remoteHostSavedSelect"')).toBeLessThan(html.indexOf('id="remoteCasePath"'));
  });

  function loadCaseDirectoryHarness() {
    const elements: Record<string, any> = {};
    const requests: Array<{ url: string; method: string; body?: any }> = [];
    const CodemanApp = function CodemanApp(this: any) {};

    for (const id of [
      'linkCasePath',
      'remoteCasePath',
      'remoteHostSavedSelect',
      'remoteHostSavedEdit',
      'remoteHostSavedAdd',
      'remoteHostConfigModal',
      'remoteHostVerifyStatus',
      'remoteHostVerifyBtn',
      'remoteHostSaveBtn',
      'remoteHostId',
      'remoteHostAddress',
      'remoteHostUsername',
      'remoteHostPort',
      'remoteHostIdentityFile',
      'remoteHostSocksProxy',
      'remoteHostJumpHost',
      'remoteHostExtraSshOptions',
      'caseDirectoryBrowserPanel',
      'caseDirectoryBrowserPath',
      'caseDirectoryBrowserList',
      'caseDirectoryBrowserError',
      'caseDirectoryBrowserSelect',
    ]) {
      elements[id] = {
        value: '',
        innerHTML: '',
        textContent: '',
        disabled: false,
        classList: { add: vi.fn(), remove: vi.fn(), toggle: vi.fn() },
        focus: vi.fn(),
      };
    }

    const context = vm.createContext({
      CodemanApp,
      localStorage: { getItem: () => null, setItem: () => {} },
      document: { getElementById: (id: string) => elements[id] ?? null },
      fetch: async (url: string, init?: { method?: string; body?: string }) => {
        requests.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body) : undefined });
        if (url === '/api/remote-hosts' && init?.method === 'POST') {
          return { json: async () => ({ success: true, data: { host: JSON.parse(init.body || '{}') } }) };
        }
        if (url === '/api/remote-hosts/gpu-box' && init?.method === 'PUT') {
          return { json: async () => ({ success: true, data: { host: JSON.parse(init.body || '{}') } }) };
        }
        if (url === '/api/remote-hosts/verify' && init?.method === 'POST') {
          return { json: async () => ({ success: true, data: { ok: true } }) };
        }
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
        if (url === '/api/remote-hosts/gpu-box/directories?path=%2Fsrv') {
          return {
            json: async () => ({
              success: true,
              data: {
                path: '/srv',
                parentPath: '/',
                entries: [{ name: 'app', path: '/srv/app' }],
              },
            }),
          };
        }
        if (url === '/api/remote-hosts/new-host' && init?.method === 'PUT') {
          return { json: async () => ({ success: true }) };
        }
        if (url === '/api/remote-hosts/new-host/directories?path=%2Fhome') {
          return {
            json: async () => ({
              success: true,
              data: {
                path: '/home',
                parentPath: '/',
                entries: [{ name: 'ubuntu', path: '/home/ubuntu' }],
              },
            }),
          };
        }
        if (url === '/api/cases/browse-local?path=%2Fprojects') {
          return {
            json: async () => ({
              success: true,
              data: {
                path: '/projects',
                parentPath: '/',
                entries: [{ name: 'codeman', path: '/projects/codeman' }],
              },
            }),
          };
        }
        throw new Error(`unexpected fetch: ${url}`);
      },
      console,
      escapeHtml: (s: string) => s,
    });

    const sessionUi = readFileSync(resolve(import.meta.dirname, '../src/web/public/session-ui.js'), 'utf8');
    vm.runInContext(sessionUi, context, { filename: 'session-ui.js' });

    const app = new (CodemanApp as any)();
    app.showToast = vi.fn();
    return { app, elements, requests };
  }

  it('loads saved remote hosts and pre-fills host fields when selected', async () => {
    const { app, elements } = loadCaseDirectoryHarness();

    await app.loadRemoteHostsForCaseModal();
    elements.remoteHostSavedSelect.value = 'gpu-box';
    app.onRemoteHostSelected();

    expect(elements.remoteHostSavedSelect.innerHTML).toContain('GPU Box');
    expect(elements.remoteHostId.value).toBe('gpu-box');
    expect(elements.remoteHostAddress.value).toBe('10.0.0.42');
    expect(elements.remoteHostUsername.value).toBe('ubuntu');
    expect(elements.remoteHostPort.value).toBe('2222');
    expect(elements.remoteHostExtraSshOptions.value).toBe('StrictHostKeyChecking=accept-new');
  });

  it('starts a new saved SSH profile from the plus action', async () => {
    const { app, elements } = loadCaseDirectoryHarness();

    await app.loadRemoteHostsForCaseModal();
    elements.remoteHostSavedSelect.value = 'gpu-box';
    app.onRemoteHostSelected();
    app.startNewRemoteHostConfig();

    expect(elements.remoteHostSavedSelect.value).toBe('');
    expect(elements.remoteHostConfigModal.classList.add).toHaveBeenCalledWith('active');
    expect(elements.remoteHostSaveBtn.disabled).toBe(true);
    expect(elements.remoteHostId.value).toBe('');
    expect(elements.remoteHostAddress.value).toBe('');
    expect(elements.remoteHostUsername.value).toBe('');
    expect(elements.remoteHostPort.value).toBe('');
  });

  it('enables saving a new SSH profile only after verification succeeds', async () => {
    const { app, elements, requests } = loadCaseDirectoryHarness();
    app.startNewRemoteHostConfig();
    elements.remoteHostId.value = 'new-host';
    elements.remoteHostAddress.value = '10.0.0.99';
    elements.remoteHostUsername.value = 'ubuntu';

    expect(elements.remoteHostSaveBtn.disabled).toBe(true);
    await app.testRemoteHostConfig();

    expect(elements.remoteHostSaveBtn.disabled).toBe(false);
    expect(elements.remoteHostVerifyStatus.textContent).toContain('verified');
    expect(requests).toContainEqual({
      url: '/api/remote-hosts/verify',
      method: 'POST',
      body: expect.objectContaining({ id: 'new-host', host: '10.0.0.99', username: 'ubuntu' }),
    });
  });

  it('saves a verified SSH profile and refreshes the saved SSH dropdown', async () => {
    const { app, elements, requests } = loadCaseDirectoryHarness();
    app.startNewRemoteHostConfig();
    elements.remoteHostId.value = 'new-host';
    elements.remoteHostAddress.value = '10.0.0.99';
    elements.remoteHostUsername.value = 'ubuntu';

    await app.testRemoteHostConfig();
    await app.saveRemoteHostConfig();

    expect(requests).toContainEqual({
      url: '/api/remote-hosts',
      method: 'POST',
      body: expect.objectContaining({ id: 'new-host', host: '10.0.0.99', username: 'ubuntu' }),
    });
    expect(elements.remoteHostConfigModal.classList.remove).toHaveBeenCalledWith('active');
    expect(elements.remoteHostSavedSelect.value).toBe('new-host');
  });

  it('opens the selected saved SSH profile for editing', async () => {
    const { app, elements } = loadCaseDirectoryHarness();
    await app.loadRemoteHostsForCaseModal();
    elements.remoteHostSavedSelect.value = 'gpu-box';

    app.editSelectedRemoteHostConfig();

    expect(elements.remoteHostConfigModal.classList.add).toHaveBeenCalledWith('active');
    expect(elements.remoteHostId.value).toBe('gpu-box');
    expect(elements.remoteHostId.disabled).toBe(true);
    expect(elements.remoteHostAddress.value).toBe('10.0.0.42');
    expect(elements.remoteHostUsername.value).toBe('ubuntu');
    expect(elements.remoteHostSaveBtn.disabled).toBe(true);
  });

  it('saves an edited verified SSH profile with PUT and refreshes the dropdown', async () => {
    const { app, elements, requests } = loadCaseDirectoryHarness();
    await app.loadRemoteHostsForCaseModal();
    elements.remoteHostSavedSelect.value = 'gpu-box';
    app.editSelectedRemoteHostConfig();
    elements.remoteHostAddress.value = '10.0.0.43';

    await app.testRemoteHostConfig();
    await app.saveRemoteHostConfig();

    expect(requests).toContainEqual({
      url: '/api/remote-hosts/gpu-box',
      method: 'PUT',
      body: expect.objectContaining({ id: 'gpu-box', host: '10.0.0.43', username: 'ubuntu' }),
    });
    expect(elements.remoteHostSavedSelect.value).toBe('gpu-box');
    expect(elements.remoteHostConfigModal.classList.remove).toHaveBeenCalledWith('active');
  });

  it('fills the remote path from the directory browser selection', async () => {
    const { app, elements, requests } = loadCaseDirectoryHarness();
    elements.remoteHostId.value = 'gpu-box';
    elements.remoteCasePath.value = '/srv';

    await app.openCaseDirectoryBrowser('remote');
    app.selectCaseDirectory('/srv/app');

    expect(elements.remoteCasePath.value).toBe('/srv/app');
    expect(requests).toContainEqual({
      url: '/api/remote-hosts/gpu-box/directories?path=%2Fsrv',
      method: 'GET',
      body: undefined,
    });
  });

  it('opens the remote directory browser directly below the remote path row', async () => {
    const { app, elements } = loadCaseDirectoryHarness();
    const remotePathRow = { insertAdjacentElement: vi.fn() };
    elements.remoteHostId.value = 'gpu-box';
    elements.remoteCasePath.value = '/srv';
    elements.remoteCasePath.closest = vi.fn(() => remotePathRow);

    await app.openCaseDirectoryBrowser('remote');

    expect(remotePathRow.insertAdjacentElement).toHaveBeenCalledWith('afterend', elements.caseDirectoryBrowserPanel);
  });

  it('requires a saved SSH profile before browsing remote directories', async () => {
    const { app, elements } = loadCaseDirectoryHarness();
    app.caseRemoteHosts = [];
    elements.remoteHostId.value = 'new-host';
    elements.remoteHostAddress.value = '10.0.0.99';
    elements.remoteHostUsername.value = 'ubuntu';
    elements.remoteCasePath.value = '/home';

    await app.openCaseDirectoryBrowser('remote');

    expect(app.showToast).toHaveBeenCalledWith('Save this SSH profile before browsing remote directories', 'error');
  });

  it('fills the linked local path from the directory browser selection', async () => {
    const { app, elements, requests } = loadCaseDirectoryHarness();
    elements.linkCasePath.value = '/projects';

    await app.openCaseDirectoryBrowser('local');
    app.selectCaseDirectory('/projects/codeman');

    expect(elements.linkCasePath.value).toBe('/projects/codeman');
    expect(requests).toContainEqual({
      url: '/api/cases/browse-local?path=%2Fprojects',
      method: 'GET',
      body: undefined,
    });
  });
});
