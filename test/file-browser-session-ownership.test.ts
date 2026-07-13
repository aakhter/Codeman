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
};

type BrowserData = {
  tree: TreeNode[];
  totalFiles: number;
  totalDirectories: number;
  truncated: boolean;
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
  fileBrowserSessionId?: string;
  fileBrowserData: BrowserData | null;
  fileBrowserFilter: string;
  fileBrowserExpandedDirs: Set<string>;
  renderFileBrowserTree: () => void;
  loadFileBrowser: (sessionId: string) => Promise<void>;
  getFileIcon: ReturnType<typeof vi.fn>;
  formatFileSize: ReturnType<typeof vi.fn>;
  hasMatchingChild: ReturnType<typeof vi.fn>;
  toggleFileBrowserFolder: ReturnType<typeof vi.fn>;
  openFilePreview: ReturnType<typeof vi.fn>;
};

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
    fileBrowserData: data,
    fileBrowserFilter: '',
    fileBrowserExpandedDirs: new Set(),
    renderFileBrowserTree: proto.renderFileBrowserTree as Host['renderFileBrowserTree'],
    loadFileBrowser: proto.loadFileBrowser as Host['loadFileBrowser'],
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
      fileBrowserData: browserData('old-session/old.docx'),
      renderFileBrowserTree: vi.fn(function (this: Host) {
        snapshots.push({ data: this.fileBrowserData, sessionId: this.fileBrowserSessionId });
      }),
    } as unknown as Host;
    host.loadFileBrowser = proto.loadFileBrowser as Host['loadFileBrowser'];

    await host.loadFileBrowser('new-session');

    expect(snapshots).toEqual([{ data: newData, sessionId: 'new-session' }]);
  });
});
