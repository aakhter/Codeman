/** @fileoverview COD-259 — attachment viewer previous/next navigation. */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

type Proto = Record<string, (...args: never[]) => unknown>;

type NavigationElements = {
  navigation: { hidden: boolean };
  previous: { disabled: boolean };
  next: { disabled: boolean };
  position: { textContent: string };
};

function loadPanelsUiPrototype(fetch: ReturnType<typeof vi.fn>): Proto {
  const source = readFileSync(resolve(import.meta.dirname, '../src/web/public/panels-ui.js'), 'utf8');
  const context = vm.createContext({
    console,
    CodemanApp: class CodemanApp {},
    escapeHtml: (value: unknown) => String(value ?? ''),
    fetch,
    setInterval: vi.fn(),
    clearInterval: vi.fn(),
    setTimeout,
    clearTimeout,
    requestAnimationFrame: vi.fn(),
    document: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
    window: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
  });
  vm.runInContext(`${source}\nglobalThis.__proto = CodemanApp.prototype;`, context);
  return (context as { __proto: Proto }).__proto;
}

function response(body: unknown, ok = true) {
  return { ok, json: vi.fn(async () => body) };
}

function navigationElements(): NavigationElements {
  return {
    navigation: { hidden: true },
    previous: { disabled: true },
    next: { disabled: true },
    position: { textContent: '' },
  };
}

function hostFor(proto: Proto, elements: NavigationElements, state: Record<string, unknown>) {
  return {
    filePreviewState: state,
    openFilePreview: vi.fn(),
    $: vi.fn((id: string) => {
      if (id === 'filePreviewNavigation') return elements.navigation;
      if (id === 'filePreviewPrevious') return elements.previous;
      if (id === 'filePreviewNext') return elements.next;
      if (id === 'filePreviewPosition') return elements.position;
      return null;
    }),
    _hideFilePreviewNavigation: proto._hideFilePreviewNavigation,
  };
}

describe('COD-259 attachment preview navigation', () => {
  it('loads attachment navigation independently whenever the preview opens', async () => {
    const fetch = vi.fn(async () => response({ success: true, data: { items: [] } }));
    const proto = loadPanelsUiPrototype(fetch);
    const elements = navigationElements();
    const overlay = { classList: { add: vi.fn() } };
    const title = { textContent: '' };
    const body = { innerHTML: '' };
    const footer = { textContent: '' };
    const host = {
      filePreviewState: null as Record<string, unknown> | null,
      _annotations: [],
      $: vi.fn((id: string) => {
        if (id === 'filePreviewOverlay') return overlay;
        if (id === 'filePreviewTitle') return title;
        if (id === 'filePreviewBody') return body;
        if (id === 'filePreviewFooter') return footer;
        if (id === 'filePreviewNavigation') return elements.navigation;
        if (id === 'filePreviewPrevious') return elements.previous;
        if (id === 'filePreviewNext') return elements.next;
        if (id === 'filePreviewPosition') return elements.position;
        return null;
      }),
      _stopFilePreviewPolling: vi.fn(),
      _restorePreviewSize: vi.fn(),
      _closeAnnotationTray: vi.fn(),
      _hideFilePreviewNavigation: proto._hideFilePreviewNavigation,
      _loadFilePreviewNavigation: proto._loadFilePreviewNavigation,
      _fetchFilePreviewMetadata: vi.fn(async () => ({ type: 'text', content: 'hello', size: 1, totalLines: 1 })),
      _filePreviewSignature: proto._filePreviewSignature,
      _renderFilePreviewBody: vi.fn(async () => true),
      _startFilePreviewPolling: vi.fn(),
    };

    await proto.openFilePreview.call(host, 'current.txt', 'session-open', null);

    expect(fetch).toHaveBeenCalledWith('/api/sessions/session-open/attachments');
  });

  it('keeps endpoint order, filters missing entries, and disables the boundaries', async () => {
    const fetch = vi.fn(async () =>
      response({
        success: true,
        data: {
          items: [
            { relativePath: 'one.pdf', attachmentId: 'one', missing: false },
            { relativePath: 'gone.pdf', attachmentId: 'gone', missing: true },
            { relativePath: 'two.pdf', attachmentId: 'two', missing: false },
            { relativePath: 'three.pdf', attachmentId: 'three', missing: false },
          ],
        },
      })
    );
    const proto = loadPanelsUiPrototype(fetch);
    const elements = navigationElements();
    // The attachment ID takes precedence even when a path happens to match a
    // different list item.
    const state = { sessionId: 'session-1', filePath: 'one.pdf', attachmentId: 'two' };
    const host = hostFor(proto, elements, state);

    await proto._loadFilePreviewNavigation.call(host, state);

    expect(fetch).toHaveBeenCalledWith('/api/sessions/session-1/attachments');
    expect(elements.navigation.hidden).toBe(false);
    expect(elements.position.textContent).toBe('2 of 3');
    expect(elements.previous.disabled).toBe(false);
    expect(elements.next.disabled).toBe(false);

    state.filePath = 'one.pdf';
    state.attachmentId = 'one';
    await proto._loadFilePreviewNavigation.call(host, state);
    expect(elements.position.textContent).toBe('1 of 3');
    expect(elements.previous.disabled).toBe(true);
    expect(elements.next.disabled).toBe(false);

    state.filePath = 'three.pdf';
    state.attachmentId = 'three';
    await proto._loadFilePreviewNavigation.call(host, state);
    expect(elements.position.textContent).toBe('3 of 3');
    expect(elements.previous.disabled).toBe(false);
    expect(elements.next.disabled).toBe(true);
  });

  it('navigates through canonical openFilePreview arguments with attachment IDs preferred', async () => {
    const proto = loadPanelsUiPrototype(vi.fn());
    const elements = navigationElements();
    const state = {
      sessionId: 'session-2',
      filePath: 'same-name.pdf',
      attachmentId: 'current-id',
      navigationItems: [
        { relativePath: 'first.pdf', attachmentId: 'first-id' },
        { relativePath: 'same-name.pdf', attachmentId: 'current-id' },
        { relativePath: 'third.pdf', attachmentId: 'third-id' },
      ],
      navigationIndex: 1,
    };
    const host = hostFor(proto, elements, state);

    proto.navigateFilePreviewAttachment.call(host, -1);
    proto.navigateFilePreviewAttachment.call(host, 1);

    expect(host.openFilePreview).toHaveBeenNthCalledWith(1, 'first.pdf', 'session-2', 'first-id');
    expect(host.openFilePreview).toHaveBeenNthCalledWith(2, 'third.pdf', 'session-2', 'third-id');
  });

  it('falls back to an exact relative path when the preview has no attachment ID', async () => {
    const fetch = vi.fn(async () =>
      response({
        success: true,
        data: {
          items: [
            { relativePath: 'first.pdf', attachmentId: 'first' },
            { relativePath: 'match.pdf', attachmentId: 'other-id' },
            { relativePath: 'last.pdf', attachmentId: 'last' },
          ],
        },
      })
    );
    const proto = loadPanelsUiPrototype(fetch);
    const elements = navigationElements();
    const state = { sessionId: 'session-3', filePath: 'match.pdf', attachmentId: null };
    const host = hostFor(proto, elements, state);

    await proto._loadFilePreviewNavigation.call(host, state);

    expect(elements.navigation.hidden).toBe(false);
    expect(elements.position.textContent).toBe('2 of 3');
  });

  it('hides navigation when a supplied attachment ID is absent from the list, even if its path matches', async () => {
    const fetch = vi.fn(async () =>
      response({
        success: true,
        data: {
          items: [
            { relativePath: 'first.pdf', attachmentId: 'first' },
            { relativePath: 'match.pdf', attachmentId: 'different-id' },
            { relativePath: 'last.pdf', attachmentId: 'last' },
          ],
        },
      })
    );
    const proto = loadPanelsUiPrototype(fetch);
    const elements = navigationElements();
    const state = { sessionId: 'session-3', filePath: 'match.pdf', attachmentId: 'missing-id' };
    const host = hostFor(proto, elements, state);

    await proto._loadFilePreviewNavigation.call(host, state);

    expect(elements.navigation.hidden).toBe(true);
    expect(elements.position.textContent).toBe('');
  });

  it.each([
    [
      'unmatched',
      response({ success: true, data: { items: [{ relativePath: 'other.pdf' }, { relativePath: 'also.pdf' }] } }),
    ],
    ['singleton', response({ success: true, data: { items: [{ relativePath: 'current.pdf' }] } })],
    ['failed', response({ success: false, error: 'nope' }, false)],
    ['malformed', response({ success: true, data: { items: 'not-an-array' } })],
  ])('hides controls for %s attachment lists', async (_caseName, result) => {
    const proto = loadPanelsUiPrototype(vi.fn(async () => result));
    const elements = navigationElements();
    const state = { sessionId: 'session-4', filePath: 'current.pdf', attachmentId: null };
    const host = hostFor(proto, elements, state);

    await proto._loadFilePreviewNavigation.call(host, state);

    expect(elements.navigation.hidden).toBe(true);
    expect(elements.position.textContent).toBe('');
    expect(elements.previous.disabled).toBe(true);
    expect(elements.next.disabled).toBe(true);
  });

  it('does not let a response after close or a newer preview alter navigation controls', async () => {
    let resolveResponse!: (value: ReturnType<typeof response>) => void;
    const fetch = vi.fn(
      () =>
        new Promise<ReturnType<typeof response>>((resolve) => {
          resolveResponse = resolve;
        })
    );
    const proto = loadPanelsUiPrototype(fetch);
    const elements = navigationElements();
    const state = { sessionId: 'session-5', filePath: 'current.pdf', attachmentId: null };
    const host = hostFor(proto, elements, state);

    const pending = proto._loadFilePreviewNavigation.call(host, state);
    host.filePreviewState = null;
    resolveResponse(
      response({ success: true, data: { items: [{ relativePath: 'before.pdf' }, { relativePath: 'current.pdf' }] } })
    );
    await pending;

    expect(elements.navigation.hidden).toBe(true);

    const newerState = { sessionId: 'session-6', filePath: 'new.pdf', attachmentId: null };
    host.filePreviewState = state;
    const pendingNewerPreview = proto._loadFilePreviewNavigation.call(host, state);
    host.filePreviewState = newerState;
    elements.navigation.hidden = false;
    elements.position.textContent = '2 of 2';
    resolveResponse(
      response({ success: true, data: { items: [{ relativePath: 'before.pdf' }, { relativePath: 'current.pdf' }] } })
    );
    await pendingNewerPreview;

    expect(elements.navigation.hidden).toBe(false);
    expect(elements.position.textContent).toBe('2 of 2');
  });
});
