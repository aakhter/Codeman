/**
 * @fileoverview COD-231 — file-browser actions must stay bound to the session
 * whose tree is displayed, even after the active terminal tab changes.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

type TreeNode = {
  name: string;
  path: string;
  type: 'file' | 'directory';
  extension?: string;
  size?: number;
  children?: TreeNode[];
};

type BrowserData = {
  tree: TreeNode[];
  totalFiles: number;
  totalDirectories: number;
  truncated: boolean;
  lazy?: boolean;
};

type FakeTreeItem = {
  dataset: { path: string; type: string };
  addEventListener: ReturnType<typeof vi.fn>;
};

type FakeTree = {
  innerHTML: string;
  querySelectorAll: ReturnType<typeof vi.fn>;
};

type Host = {
  $: ReturnType<typeof vi.fn>;
  activeSessionId: string;
  fileBrowserSessionId: string | null;
  fileBrowserLoadGeneration: number;
  fileBrowserData: BrowserData | null;
  fileBrowserFilter: string;
  fileBrowserAllExpanded: boolean;
  fileBrowserExpandedDirs: Set<string>;
  fileBrowserShowHidden?: boolean;
  renderFileBrowserTree: () => void;
  loadFileBrowser: (sessionId: string) => Promise<void>;
  refreshFileBrowser: () => void;
  getFileIcon: ReturnType<typeof vi.fn>;
  formatFileSize: ReturnType<typeof vi.fn>;
  hasMatchingChild: ReturnType<typeof vi.fn>;
  toggleFileBrowserFolder: ReturnType<typeof vi.fn>;
  openFilePreview: ReturnType<typeof vi.fn>;
};

type FetchResponse = {
  ok: boolean;
  json: () => Promise<{ success: boolean; data?: BrowserData; error?: string }>;
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function successfulResponse(data: BrowserData): FetchResponse {
  return {
    ok: true,
    json: async () => ({ success: true, data }),
  };
}

function loadPanelsUiPrototype(fetchImpl = vi.fn()): Record<string, (...args: never[]) => unknown> {
  const source = readFileSync(resolve(import.meta.dirname, '../src/web/public/panels-ui.js'), 'utf8');
  const context = vm.createContext({
    console,
    CodemanApp: class CodemanApp {},
    escapeHtml: (value: unknown) => String(value ?? ''),
    fetch: fetchImpl,
    setInterval: vi.fn(),
    clearInterval: vi.fn(),
    setTimeout,
    clearTimeout,
    requestAnimationFrame: vi.fn(),
    document: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
    window: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
  });
  vm.runInContext(`${source}\nglobalThis.__proto = CodemanApp.prototype;`, context);
  return (context as { __proto: Record<string, (...args: never[]) => unknown> }).__proto;
}

function browserData(path: string): BrowserData {
  return {
    tree: [{ name: path.split('/').at(-1) ?? path, path, type: 'file', extension: 'docx', size: 1024 }],
    totalFiles: 1,
    totalDirectories: 0,
    truncated: false,
  };
}

function fakeTree(path: string): { tree: FakeTree; item: FakeTreeItem } {
  const item: FakeTreeItem = {
    dataset: { path, type: 'file' },
    addEventListener: vi.fn(),
  };
  return {
    tree: {
      innerHTML: '',
      querySelectorAll: vi.fn(() => [item]),
    },
    item,
  };
}

function renderHost(proto: Record<string, (...args: never[]) => unknown>, tree: FakeTree, data: BrowserData): Host {
  return {
    $: vi.fn((id: string) => (id === 'fileBrowserTree' ? tree : null)),
    activeSessionId: 'new-active-session',
    fileBrowserSessionId: 'tree-owner-session',
    fileBrowserLoadGeneration: 0,
    fileBrowserData: data,
    fileBrowserFilter: '',
    fileBrowserAllExpanded: false,
    fileBrowserExpandedDirs: new Set(),
    renderFileBrowserTree: proto.renderFileBrowserTree as Host['renderFileBrowserTree'],
    loadFileBrowser: proto.loadFileBrowser as Host['loadFileBrowser'],
    refreshFileBrowser: proto.refreshFileBrowser as Host['refreshFileBrowser'],
    getFileIcon: vi.fn(() => 'FILE'),
    formatFileSize: vi.fn(() => '1 KB'),
    hasMatchingChild: vi.fn(() => false),
    toggleFileBrowserFolder: vi.fn(),
    openFilePreview: vi.fn(),
  };
}

describe('COD-231 file-browser session ownership', () => {
  it('retains the requested session as the owner when a tree load succeeds', async () => {
    const data = browserData('deliverables/story.docx');
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ success: true, data }),
    }));
    const proto = loadPanelsUiPrototype(fetchImpl);
    const tree = { innerHTML: '', querySelectorAll: vi.fn(() => []) };
    const status = { textContent: '' };
    const host = {
      $: vi.fn((id: string) => (id === 'fileBrowserTree' ? tree : id === 'fileBrowserStatus' ? status : null)),
      activeSessionId: 'different-active-session',
      fileBrowserSessionId: null,
      fileBrowserLoadGeneration: 0,
      fileBrowserData: null,
      renderFileBrowserTree: vi.fn(),
    } as unknown as Host;
    host.loadFileBrowser = proto.loadFileBrowser as Host['loadFileBrowser'];

    await host.loadFileBrowser('requested-session');

    expect(host.fileBrowserData).toBe(data);
    expect(host.fileBrowserSessionId).toBe('requested-session');
    expect(host.renderFileBrowserTree).toHaveBeenCalledOnce();
  });

  it('passes the stored tree owner to preview after the active tab changes', () => {
    const proto = loadPanelsUiPrototype();
    const path = 'deliverables/story.docx';
    const { tree, item } = fakeTree(path);
    const host = renderHost(proto, tree, browserData(path));

    host.renderFileBrowserTree();
    const clickHandler = item.addEventListener.mock.calls.find(([event]) => event === 'click')?.[1] as
      | (() => void)
      | undefined;
    expect(clickHandler).toBeTypeOf('function');

    clickHandler?.();

    expect(host.openFilePreview).toHaveBeenCalledWith(path, 'tree-owner-session');
    expect(host.openFilePreview).not.toHaveBeenCalledWith(path, 'new-active-session');
  });

  it('builds download links with the stored tree owner instead of the active tab', () => {
    const proto = loadPanelsUiPrototype();
    const path = 'deliverables/story.docx';
    const { tree } = fakeTree(path);
    const host = renderHost(proto, tree, browserData(path));

    host.renderFileBrowserTree();

    expect(tree.innerHTML).toContain('/api/sessions/tree-owner-session/file-raw?');
    expect(tree.innerHTML).not.toContain('/api/sessions/new-active-session/file-raw?');
  });

  it('replaces tree data and its owner together before rendering a newly loaded session', async () => {
    const newData = browserData('new-session/report.pdf');
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ success: true, data: newData }),
    }));
    const proto = loadPanelsUiPrototype(fetchImpl);
    const tree = { innerHTML: '', querySelectorAll: vi.fn(() => []) };
    const snapshots: Array<{ data: BrowserData | null; sessionId?: string }> = [];
    const host = {
      $: vi.fn((id: string) => (id === 'fileBrowserTree' ? tree : null)),
      activeSessionId: 'unrelated-active-session',
      fileBrowserSessionId: 'old-session',
      fileBrowserLoadGeneration: 0,
      fileBrowserData: browserData('old-session/old.docx'),
      renderFileBrowserTree: vi.fn(function (this: Host) {
        snapshots.push({ data: this.fileBrowserData, sessionId: this.fileBrowserSessionId });
      }),
    } as unknown as Host;
    host.loadFileBrowser = proto.loadFileBrowser as Host['loadFileBrowser'];

    await host.loadFileBrowser('new-session');

    expect(snapshots).toEqual([{ data: newData, sessionId: 'new-session' }]);
  });

  it('ignores an older successful load that resolves after the latest session tree', async () => {
    const requestA = deferred<FetchResponse>();
    const requestB = deferred<FetchResponse>();
    const fetchImpl = vi
      .fn()
      .mockImplementationOnce(() => requestA.promise)
      .mockImplementationOnce(() => requestB.promise);
    const proto = loadPanelsUiPrototype(fetchImpl);
    const tree = { innerHTML: '', querySelectorAll: vi.fn(() => []) };
    const status = { textContent: '' };
    const dataA = browserData('session-a/stale.docx');
    const dataB = browserData('session-b/current.docx');
    const host = {
      $: vi.fn((id: string) => (id === 'fileBrowserTree' ? tree : id === 'fileBrowserStatus' ? status : null)),
      activeSessionId: 'session-b',
      fileBrowserSessionId: null,
      fileBrowserLoadGeneration: 0,
      fileBrowserData: null,
      renderFileBrowserTree: vi.fn(function (this: Host) {
        tree.innerHTML = `rendered:${this.fileBrowserSessionId}`;
      }),
    } as unknown as Host;
    host.loadFileBrowser = proto.loadFileBrowser as Host['loadFileBrowser'];

    const loadA = host.loadFileBrowser('session-a');
    const loadB = host.loadFileBrowser('session-b');
    requestB.resolve(successfulResponse(dataB));
    await loadB;

    expect(host.fileBrowserSessionId).toBe('session-b');
    expect(host.fileBrowserData).toBe(dataB);
    expect(tree.innerHTML).toBe('rendered:session-b');
    expect(status.textContent).toBe('1 files, 0 dirs');

    requestA.resolve(successfulResponse(dataA));
    await loadA;

    expect(host.fileBrowserSessionId).toBe('session-b');
    expect(host.fileBrowserData).toBe(dataB);
    expect(host.renderFileBrowserTree).toHaveBeenCalledOnce();
    expect(tree.innerHTML).toBe('rendered:session-b');
    expect(status.textContent).toBe('1 files, 0 dirs');
  });

  it('ignores an older failed load after the latest session tree succeeds', async () => {
    const requestA = deferred<FetchResponse>();
    const requestB = deferred<FetchResponse>();
    const fetchImpl = vi
      .fn()
      .mockImplementationOnce(() => requestA.promise)
      .mockImplementationOnce(() => requestB.promise);
    const proto = loadPanelsUiPrototype(fetchImpl);
    const tree = { innerHTML: '', querySelectorAll: vi.fn(() => []) };
    const status = { textContent: '' };
    const dataB = browserData('session-b/current.docx');
    const host = {
      $: vi.fn((id: string) => (id === 'fileBrowserTree' ? tree : id === 'fileBrowserStatus' ? status : null)),
      activeSessionId: 'session-b',
      fileBrowserSessionId: null,
      fileBrowserLoadGeneration: 0,
      fileBrowserData: null,
      renderFileBrowserTree: vi.fn(function (this: Host) {
        tree.innerHTML = `rendered:${this.fileBrowserSessionId}`;
      }),
    } as unknown as Host;
    host.loadFileBrowser = proto.loadFileBrowser as Host['loadFileBrowser'];
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const loadA = host.loadFileBrowser('session-a');
      const loadB = host.loadFileBrowser('session-b');
      requestB.resolve(successfulResponse(dataB));
      await loadB;
      requestA.resolve({ ok: false, json: async () => ({ success: false, error: 'stale failure' }) });
      await loadA;

      expect(host.fileBrowserSessionId).toBe('session-b');
      expect(host.fileBrowserData).toBe(dataB);
      expect(host.renderFileBrowserTree).toHaveBeenCalledOnce();
      expect(tree.innerHTML).toBe('rendered:session-b');
      expect(status.textContent).toBe('1 files, 0 dirs');
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it('refreshes the displayed tree owner after the active tab changes', () => {
    const proto = loadPanelsUiPrototype();
    const searchInput = { value: 'old filter' };
    const host = {
      $: vi.fn((id: string) => (id === 'fileBrowserSearch' ? searchInput : null)),
      activeSessionId: 'new-active-session',
      fileBrowserSessionId: 'tree-owner-session',
      fileBrowserData: browserData('tree-owner-session/story.docx'),
      fileBrowserFilter: 'story',
      fileBrowserAllExpanded: true,
      fileBrowserExpandedDirs: new Set(['tree-owner-session']),
      loadFileBrowser: vi.fn(),
    } as unknown as Host;
    host.refreshFileBrowser = proto.refreshFileBrowser as Host['refreshFileBrowser'];

    host.refreshFileBrowser();

    expect(host.loadFileBrowser).toHaveBeenCalledWith('tree-owner-session');
    expect(host.loadFileBrowser).not.toHaveBeenCalledWith('new-active-session');
    expect(host.fileBrowserExpandedDirs.size).toBe(0);
    expect(host.fileBrowserFilter).toBe('');
    expect(host.fileBrowserAllExpanded).toBe(false);
    expect(searchInput.value).toBe('');
  });

  it('lazy-loads an expanded remote directory into the displayed tree', async () => {
    const children: TreeNode[] = [{ name: 'index.ts', path: 'src/index.ts', type: 'file' }];
    const fetchImpl = vi.fn(async () =>
      successfulResponse({ tree: children, totalFiles: 1, totalDirectories: 0, truncated: false, lazy: true })
    );
    const proto = loadPanelsUiPrototype(fetchImpl);
    const host = {
      $: vi.fn(() => null),
      activeSessionId: 'new-active-session',
      fileBrowserSessionId: 'tree-owner-session',
      fileBrowserLoadGeneration: 7,
      fileBrowserData: {
        tree: [{ name: 'src', path: 'src', type: 'directory', children: [] }],
        totalFiles: 0,
        totalDirectories: 1,
        truncated: false,
        lazy: true,
      },
      fileBrowserFilter: '',
      fileBrowserExpandedDirs: new Set<string>(),
      fileBrowserShowHidden: false,
      renderFileBrowserTree: vi.fn(),
    } as unknown as Host;
    host.toggleFileBrowserFolder = proto.toggleFileBrowserFolder as Host['toggleFileBrowserFolder'];

    await host.toggleFileBrowserFolder('src');

    expect(fetchImpl).toHaveBeenCalledWith('/api/sessions/tree-owner-session/files?path=src&showHidden=false');
    expect(host.fileBrowserData?.tree[0].children).toEqual(children);
    expect(host.renderFileBrowserTree).toHaveBeenCalledOnce();
  });

  it('drops a lazy directory response after a new tree load starts', async () => {
    const request = deferred<FetchResponse>();
    const proto = loadPanelsUiPrototype(vi.fn(() => request.promise));
    const host = {
      $: vi.fn(() => null),
      activeSessionId: 'new-active-session',
      fileBrowserSessionId: 'tree-owner-session',
      fileBrowserLoadGeneration: 7,
      fileBrowserData: {
        tree: [{ name: 'src', path: 'src', type: 'directory', children: [] }],
        totalFiles: 0,
        totalDirectories: 1,
        truncated: false,
        lazy: true,
      },
      fileBrowserFilter: '',
      fileBrowserExpandedDirs: new Set<string>(),
      renderFileBrowserTree: vi.fn(),
    } as unknown as Host;
    host.toggleFileBrowserFolder = proto.toggleFileBrowserFolder as Host['toggleFileBrowserFolder'];

    const expand = host.toggleFileBrowserFolder('src');
    host.fileBrowserLoadGeneration++;
    request.resolve(
      successfulResponse({
        tree: [{ name: 'stale.ts', path: 'src/stale.ts', type: 'file' }],
        totalFiles: 1,
        totalDirectories: 0,
        truncated: false,
        lazy: true,
      })
    );
    await expand;

    expect(host.fileBrowserData?.tree[0].children).toEqual([]);
    expect(host.renderFileBrowserTree).not.toHaveBeenCalled();
  });

  it('initializes the file-browser owner and load generation with the other browser state', () => {
    const appSource = readFileSync(resolve(import.meta.dirname, '../src/web/public/app.js'), 'utf8');

    expect(appSource).toContain('this.fileBrowserSessionId = null;');
    expect(appSource).toContain('this.fileBrowserLoadGeneration = 0;');
  });
});
