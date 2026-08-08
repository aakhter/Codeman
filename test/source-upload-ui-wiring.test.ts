/**
 * @fileoverview COD-281 Session Sources browser-upload wiring.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Proto = Record<string, (...args: unknown[]) => unknown>;

const fetchMock = vi.fn();
const getElementById = vi.fn();

function loadPanelsUiPrototype(): Proto {
  const source = readFileSync(resolve(import.meta.dirname, '../src/web/public/panels-ui.js'), 'utf8');
  const context = vm.createContext({
    console,
    CodemanApp: class CodemanApp {},
    escapeHtml: (value: unknown) => String(value ?? ''),
    fetch: fetchMock,
    FormData,
    Blob,
    setInterval: vi.fn(),
    clearInterval: vi.fn(),
    setTimeout,
    clearTimeout,
    requestAnimationFrame: vi.fn(),
    URL: { createObjectURL: vi.fn(), revokeObjectURL: vi.fn() },
    document: { addEventListener: vi.fn(), removeEventListener: vi.fn(), getElementById },
    window: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
  });
  vm.runInContext(`${source}\nglobalThis.__proto = CodemanApp.prototype;`, context);
  return (context as { __proto: Proto }).__proto;
}

const PROTO = loadPanelsUiPrototype();

function makeElements(overrides: Record<string, unknown> = {}) {
  return {
    sourcesFilePicker: { files: [], value: '' },
    sourcesTitle: { value: '' },
    sourcesUploadBtn: { disabled: false, textContent: 'Upload' },
    ...overrides,
  };
}

describe('COD-281 source upload wiring', () => {
  let host: { activeSessionId: string; loadSources: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    fetchMock.mockReset();
    getElementById.mockReset();
    host = { activeSessionId: 's1', loadSources: vi.fn() };
  });

  it('POSTs the picked file to /sources/upload and reloads sources after success', async () => {
    const file = new Blob(['notes'], { type: 'text/plain' });
    Object.defineProperty(file, 'name', { value: 'notes.txt' });
    const elements = makeElements({ sourcesFilePicker: { files: [file], value: 'picked' } });
    getElementById.mockImplementation((id: string) => elements[id as keyof typeof elements]);
    fetchMock.mockResolvedValue({ json: async () => ({ success: true }) });

    await (PROTO.handleSourceUpload as () => Promise<void>).call(host);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/sessions/s1/sources/upload');
    expect(init.method).toBe('POST');
    expect(init.body).toBeInstanceOf(FormData);
    const submittedFile = init.body.get('file') as Blob;
    expect(submittedFile).toBeInstanceOf(Blob);
    expect(submittedFile.type).toBe('text/plain');
    expect(await submittedFile.text()).toBe('notes');
    expect(host.loadSources).toHaveBeenCalledTimes(1);
  });

  it('does not POST when no file is selected', async () => {
    const elements = makeElements();
    getElementById.mockImplementation((id: string) => elements[id as keyof typeof elements]);

    await (PROTO.handleSourceUpload as () => Promise<void>).call(host);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(host.loadSources).not.toHaveBeenCalled();
  });

  it('restores the upload button after a network error', async () => {
    const btn = { disabled: false, textContent: 'Upload' };
    const elements = makeElements({
      sourcesFilePicker: { files: [{ name: 'notes.txt', type: 'text/plain' }], value: 'picked' },
      sourcesUploadBtn: btn,
    });
    getElementById.mockImplementation((id: string) => elements[id as keyof typeof elements]);
    fetchMock.mockRejectedValue(new Error('network'));

    await (PROTO.handleSourceUpload as () => Promise<void>).call(host);

    expect(btn).toEqual({ disabled: false, textContent: 'Upload' });
    expect(host.loadSources).not.toHaveBeenCalled();
  });
});
