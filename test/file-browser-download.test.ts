/**
 * @fileoverview COD-233 — a Files-panel download failure must surface a toast and
 * never navigate the SPA away. The download control previously was a bare
 * navigating <a href> whose non-2xx JSON error body (from file-raw) replaced the
 * whole terminal view. These tests pin the guarded fetch-based behavior.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

type Proto = Record<string, (...args: never[]) => unknown>;

type FakeAnchor = {
  href: string;
  download: string;
  rel: string;
  click: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
};

function loadPanelsUiPrototype(contextOverrides: Record<string, unknown> = {}): Proto {
  const source = readFileSync(resolve(import.meta.dirname, '../src/web/public/panels-ui.js'), 'utf8');
  const context = vm.createContext({
    console,
    CodemanApp: class CodemanApp {},
    escapeHtml: (value: unknown) => String(value ?? ''),
    fetch: vi.fn(),
    setInterval: vi.fn(),
    clearInterval: vi.fn(),
    setTimeout,
    clearTimeout,
    requestAnimationFrame: vi.fn(),
    document: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
    window: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
    URL: { createObjectURL: vi.fn(() => 'blob:fake'), revokeObjectURL: vi.fn() },
    Blob: class {},
    ...contextOverrides,
  });
  vm.runInContext(`${source}\nglobalThis.__proto = CodemanApp.prototype;`, context);
  return (context as { __proto: Proto }).__proto;
}

function browserData(path: string) {
  return {
    tree: [{ name: path.split('/').at(-1) ?? path, path, type: 'file' as const, extension: 'docx', size: 1024 }],
    totalFiles: 1,
    totalDirectories: 0,
    truncated: false,
  };
}

/** A document stub that records anchors created for blob downloads. */
function fakeDocument(anchors: FakeAnchor[]) {
  return {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    createElement: vi.fn((tag: string) => {
      if (tag !== 'a') throw new Error(`unexpected createElement(${tag})`);
      const a: FakeAnchor = { href: '', download: '', rel: '', click: vi.fn(), remove: vi.fn() };
      anchors.push(a);
      return a;
    }),
    body: { appendChild: vi.fn() },
  };
}

describe('COD-233 guarded Files-panel download', () => {
  it('shows a toast and does not navigate when the server returns a non-2xx error', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 404,
      json: async () => ({ success: false, error: 'File not found', errorCode: 'NOT_FOUND' }),
    }));
    const anchors: FakeAnchor[] = [];
    const doc = fakeDocument(anchors);
    const proto = loadPanelsUiPrototype({ fetch: fetchImpl, document: doc });

    const showToast = vi.fn();
    const host = { showToast } as unknown as {
      showToast: ReturnType<typeof vi.fn>;
      downloadWorkspaceFile: (sessionId: string, path: string) => Promise<void>;
    };
    host.downloadWorkspaceFile = proto.downloadWorkspaceFile as typeof host.downloadWorkspaceFile;

    await host.downloadWorkspaceFile('tree-owner-session', 'deliverables/story.docx');

    // The server error surfaces as a toast, not a page navigation.
    expect(showToast).toHaveBeenCalledWith('File not found', 'error');
    // No blob anchor is created on the failure path (nothing to save).
    expect(anchors).toHaveLength(0);
    // The request targeted the correct owner-scoped raw endpoint.
    expect(fetchImpl).toHaveBeenCalledWith(
      '/api/sessions/tree-owner-session/file-raw?path=deliverables%2Fstory.docx&download=true'
    );
  });

  it('streams a blob download via a temporary anchor on success', async () => {
    const blob = { type: 'application/octet-stream' };
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      blob: async () => blob,
    }));
    const anchors: FakeAnchor[] = [];
    const doc = fakeDocument(anchors);
    const createObjectURL = vi.fn(() => 'blob:ok');
    const revokeObjectURL = vi.fn();
    const proto = loadPanelsUiPrototype({
      fetch: fetchImpl,
      document: doc,
      URL: { createObjectURL, revokeObjectURL },
    });

    const showToast = vi.fn();
    const host = { showToast } as unknown as {
      showToast: ReturnType<typeof vi.fn>;
      downloadWorkspaceFile: (sessionId: string, path: string) => Promise<void>;
    };
    host.downloadWorkspaceFile = proto.downloadWorkspaceFile as typeof host.downloadWorkspaceFile;

    await host.downloadWorkspaceFile('tree-owner-session', 'deliverables/story.docx');

    expect(createObjectURL).toHaveBeenCalledWith(blob);
    expect(anchors).toHaveLength(1);
    expect(anchors[0].download).toBe('story.docx');
    expect(anchors[0].click).toHaveBeenCalledOnce();
    expect(showToast).not.toHaveBeenCalled();
  });

  it('routes the render-time download control through the guarded downloader, not navigation', () => {
    const proto = loadPanelsUiPrototype();
    const path = 'deliverables/story.docx';
    const downloadEl = { dataset: { path }, addEventListener: vi.fn() };
    const itemEl = { dataset: { path, type: 'file' }, addEventListener: vi.fn() };
    const tree = {
      innerHTML: '',
      querySelectorAll: vi.fn((sel: string) => (sel === '.file-tree-download' ? [downloadEl] : [itemEl])),
    };
    const downloadWorkspaceFile = vi.fn();
    const host = {
      $: vi.fn((id: string) => (id === 'fileBrowserTree' ? tree : null)),
      fileBrowserSessionId: 'tree-owner-session',
      fileBrowserData: browserData(path),
      fileBrowserFilter: '',
      fileBrowserExpandedDirs: new Set<string>(),
      getFileIcon: vi.fn(() => 'FILE'),
      formatFileSize: vi.fn(() => '1 KB'),
      hasMatchingChild: vi.fn(() => false),
      downloadWorkspaceFile,
      renderFileBrowserTree: proto.renderFileBrowserTree as () => void,
    };

    host.renderFileBrowserTree();

    const handler = downloadEl.addEventListener.mock.calls.find(([event]) => event === 'click')?.[1] as
      | ((e: { preventDefault: () => void; stopPropagation: () => void }) => void)
      | undefined;
    expect(handler).toBeTypeOf('function');

    const evt = { preventDefault: vi.fn(), stopPropagation: vi.fn() };
    handler?.(evt);

    expect(evt.preventDefault).toHaveBeenCalledOnce();
    expect(evt.stopPropagation).toHaveBeenCalledOnce();
    expect(downloadWorkspaceFile).toHaveBeenCalledWith('tree-owner-session', path);
  });
});
