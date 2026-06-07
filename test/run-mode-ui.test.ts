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
});

describe('Codex quick start settings', () => {
  it('renders Codex CLI settings in a dedicated app settings tab', () => {
    const html = readFileSync(resolve(import.meta.dirname, '../src/web/public/index.html'), 'utf8');

    expect(html).toContain('data-tab="settings-codex">Codex CLI</button>');

    const claudeTab = html.match(
      /<div class="modal-tab-content hidden" id="settings-claude">([\s\S]*?)<!-- Codex CLI Tab -->/
    );
    expect(claudeTab?.[1]).not.toContain('appSettingsCodexDangerouslyBypassApprovals');

    const codexTab = html.match(
      /<div class="modal-tab-content hidden" id="settings-codex">([\s\S]*?)<\/div>\s*<!-- Models Tab -->/
    );
    expect(codexTab?.[1]).toContain('appSettingsCodexDangerouslyBypassApprovals');
    expect(codexTab?.[1]).not.toContain('appSettingsCodexRenderMode');
  });

  it('renders terminal history settings with scrollback-matched replay defaults', () => {
    const html = readFileSync(resolve(import.meta.dirname, '../src/web/public/index.html'), 'utf8');
    const settingsUi = readFileSync(resolve(import.meta.dirname, '../src/web/public/settings-ui.js'), 'utf8');

    expect(html).toContain('appSettingsTerminalScrollbackLines');
    expect(html).toContain('appSettingsTmuxHistoryLimit');
    expect(html).toContain('appSettingsTerminalBufferMaxMiB');
    expect(html).toContain('appSettingsTerminalBufferTrimMiB');
    expect(settingsUi).toContain('terminalScrollbackLines: 100000');
    expect(settingsUi).toContain('tmuxHistoryLimit: 100000');
    expect(settingsUi).toContain('terminalBufferMaxBytes: 32 * 1024 * 1024');
    expect(settingsUi).toContain('terminalBufferTrimBytes: 24 * 1024 * 1024');
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
      fetch: async (url: string, init?: { body?: string }) => {
        requests.push({ url, body: init?.body ? JSON.parse(init.body) : undefined });
        if (url === '/api/codex/status') return { json: async () => ({ available: true }) };
        if (url === '/api/quick-start') return { json: async () => ({ success: true, sessionId: 'sess-1' }) };
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
        if (url === '/api/settings') return { ok: true, json: async () => ({ lastUsedCase: 'deleted-case' }) };
        if (url === '/api/cases') return { json: async () => [{ name: 'kept-case', path: '/tmp/kept-case' }] };
        if (url === '/api/cases/kept-case') return { json: async () => ({ path: '/tmp/kept-case' }) };
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

describe('mobile header utilities', () => {
  it('renders a mobile utility toggle and collapsible header-right tray without shrinking tabs', () => {
    const html = readFileSync(resolve(import.meta.dirname, '../src/web/public/index.html'), 'utf8');
    const settingsUi = readFileSync(resolve(import.meta.dirname, '../src/web/public/settings-ui.js'), 'utf8');
    const mobileCss = readFileSync(resolve(import.meta.dirname, '../src/web/public/mobile.css'), 'utf8');

    expect(html).toContain('id="mobileHeaderUtilityToggle"');
    expect(html).toContain('aria-controls="headerRight"');
    expect(html).toContain('<div class="header-right mobile-collapsed" id="headerRight">');

    expect(settingsUi).toContain('toggleMobileHeaderUtilities()');
    expect(settingsUi).toContain('bindMobileHeaderUtilityToggle()');
    expect(settingsUi).toContain('closeMobileHeaderUtilities()');

    expect(mobileCss).toContain('.mobile-header-utility-toggle');
    expect(mobileCss).toContain('.header-right.mobile-collapsed');
    expect(mobileCss).toContain('position: fixed');
    expect(mobileCss).toContain('.session-tabs');
    expect(mobileCss).toContain('flex: 1');
  });
});
