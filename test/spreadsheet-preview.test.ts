/** @vitest-environment jsdom */
/** @fileoverview COD-280 spreadsheet renderer lifecycle and virtualization. */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const source = readFileSync(resolve(import.meta.dirname, '../src/web/public/spreadsheet-preview.js'), 'utf8');
const panelsSource = readFileSync(resolve(import.meta.dirname, '../src/web/public/panels-ui.js'), 'utf8');

class WorkerMock {
  static instances: WorkerMock[] = [];
  onmessage: ((event: { data: any }) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  postMessage = vi.fn();
  terminate = vi.fn();
  constructor(readonly url: string) {
    WorkerMock.instances.push(this);
  }
  emit(data: unknown) {
    this.onmessage?.({ data });
  }
}

function loadRenderer(fetchMock: ReturnType<typeof vi.fn>) {
  const context = vm.createContext({
    window,
    document,
    URL,
    AbortController,
    Worker: WorkerMock,
    ResizeObserver: undefined,
    fetch: fetchMock,
    setTimeout,
    clearTimeout,
    console,
  });
  vm.runInContext(source, context);
  return (window as any).CodemanSpreadsheetPreview as { open(options: Record<string, unknown>): { dispose(): void } };
}

function metadata() {
  return {
    type: 'metadata',
    sheets: [
      {
        id: '1',
        name: '<Summary>',
        rows: 1_000_000,
        cols: 100,
        defaultRowHeight: 20,
        defaultColumnWidth: 64,
        rowOverrides: [],
        columnOverrides: [],
      },
      { id: '2', name: 'Details', rows: 1, cols: 1, defaultRowHeight: 20, defaultColumnWidth: 64 },
    ],
  };
}

describe('spreadsheet preview renderer', () => {
  beforeEach(() => {
    WorkerMock.instances = [];
    document.body.innerHTML = '<div id="preview"></div>';
    delete (window as any).CodemanSpreadsheetPreview;
    window.requestAnimationFrame = (callback: FrameRequestCallback) =>
      setTimeout(() => callback(0), 0) as unknown as number;
    window.cancelAnimationFrame = (id: number) => clearTimeout(id);
  });

  it('refuses oversized metadata before fetch or worker creation', () => {
    const fetchMock = vi.fn();
    const renderer = loadRenderer(fetchMock);
    renderer.open({ container: document.querySelector('#preview'), url: '/book.xlsx', size: 10 * 1024 * 1024 + 1 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(WorkerMock.instances).toHaveLength(0);
    expect(document.body.textContent).toContain('10 MB limit');
  });

  it('fetches same-origin preview bytes, transfers them, and bounds rendered cells', async () => {
    const bytes = new ArrayBuffer(8);
    const fetchMock = vi.fn(async () => ({ ok: true, arrayBuffer: async () => bytes }));
    const renderer = loadRenderer(fetchMock);
    renderer.open({ container: document.querySelector('#preview'), url: '/api/book.xlsx', size: 8 });
    const worker = WorkerMock.instances[0];
    worker.emit({ type: 'ready' });
    await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalledWith({ type: 'load', bytes }, [bytes]));
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/book.xlsx?preview=true',
      expect.objectContaining({ signal: expect.anything() })
    );

    worker.emit(metadata());
    const tileRequest = worker.postMessage.mock.calls.at(-1)?.[0];
    expect(tileRequest.type).toBe('tile');
    expect(tileRequest.range.r2 - tileRequest.range.r1).toBeLessThan(100);
    worker.emit({
      type: 'tile',
      requestId: tileRequest.requestId,
      sheetId: '1',
      cells: Array.from({ length: 3000 }, (_, index) => ({
        row: index + 1,
        col: 1,
        text: `<b>${index}</b>`,
        styleId: 0,
      })),
    });
    expect(document.querySelectorAll('.spreadsheet-cell')).toHaveLength(2500);
    expect(document.querySelector('.spreadsheet-cell')?.textContent).toBe('<b>0</b>');
    expect(document.querySelector('.spreadsheet-sheet-tabs')?.hasAttribute('data-i18n-skip')).toBe(true);
    expect(document.querySelector('.spreadsheet-grid')?.hasAttribute('data-i18n-skip')).toBe(true);
    expect(Number.parseFloat((document.querySelector('.spreadsheet-grid-spacer') as HTMLElement).style.height)).toBe(
      8_000_000
    );
    (document.querySelectorAll('[role="tab"]')[1] as HTMLButtonElement).click();
    expect((document.querySelector('.spreadsheet-grid-spacer') as HTMLElement).style.height).toBe('20px');
  });

  it('drops stale tiles and aborts fetch plus terminates worker on dispose', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) }));
    const renderer = loadRenderer(fetchMock);
    const handle = renderer.open({ container: document.querySelector('#preview'), url: '/book.xlsx', size: 8 });
    const worker = WorkerMock.instances[0];
    worker.emit({ type: 'ready' });
    await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalled());
    worker.emit(metadata());
    const request = worker.postMessage.mock.calls.at(-1)?.[0];
    worker.emit({
      type: 'tile',
      requestId: request.requestId - 1,
      sheetId: '1',
      cells: [{ row: 1, col: 1, text: 'stale' }],
    });
    expect(document.body.textContent).not.toContain('stale');
    const signal = fetchMock.mock.calls[0][1].signal as AbortSignal;
    handle.dispose();
    expect(signal.aborted).toBe(true);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it('shows feature warnings and reports worker failures after readiness', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) }));
    const renderer = loadRenderer(fetchMock);
    renderer.open({ container: document.querySelector('#preview'), url: '/book.xlsx', size: 8 });
    const worker = WorkerMock.instances[0];
    worker.emit({ type: 'ready' });
    await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalled());
    worker.emit({ ...metadata(), warnings: ['charts'] });
    const request = worker.postMessage.mock.calls.at(-1)?.[0];
    worker.emit({ type: 'tile', requestId: request.requestId, sheetId: '1', cells: [], warnings: [] });
    expect(document.body.textContent).toContain('charts');
    worker.onerror?.();
    expect(document.body.textContent).toContain('Spreadsheet parser failed');
  });

  it('integrates with the shared overlay and disposes the prior spreadsheet lifecycle', async () => {
    const dispose = vi.fn();
    const open = vi.fn(() => ({ dispose }));
    const panelContext = vm.createContext({
      console,
      CodemanApp: class CodemanApp {},
      escapeHtml: (value: unknown) => String(value ?? ''),
      fetch: vi.fn(),
      setInterval: vi.fn(),
      clearInterval: vi.fn(),
      setTimeout,
      clearTimeout,
      requestAnimationFrame: vi.fn(),
      AbortController,
      document,
      window: { CodemanSpreadsheetPreview: { open }, addEventListener: vi.fn(), removeEventListener: vi.fn() },
    });
    vm.runInContext(`${panelsSource}\nglobalThis.__proto = CodemanApp.prototype;`, panelContext);
    const proto = (panelContext as any).__proto;
    const body = document.querySelector('#preview') as HTMLElement;
    const footer = document.createElement('div');
    const oldDispose = vi.fn();
    const state = { spreadsheetPreview: { dispose: oldDispose } };
    const host: Record<string, any> = {
      filePreviewState: state,
      filePreviewContent: '',
      formatFileSize: () => '8 KB',
      $: (id: string) => (id === 'filePreviewBody' ? body : id === 'filePreviewFooter' ? footer : null),
      _disposeSpreadsheetPreview: proto._disposeSpreadsheetPreview,
    };

    const rendered = await proto._renderFilePreviewBody.call(
      host,
      { type: 'spreadsheet', size: 8192, previewUrl: '/api/book.xlsx?preview=true' },
      { sessionId: 's1', filePath: 'book.xlsx', attachmentId: null },
      state
    );

    expect(rendered).toBe(true);
    expect(oldDispose).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith(
      expect.objectContaining({ container: body, url: '/api/book.xlsx?preview=true', size: 8192 })
    );
    expect(state.spreadsheetPreview).toEqual({ dispose });
    expect(footer.textContent).toContain('Spreadsheet');
  });
});
