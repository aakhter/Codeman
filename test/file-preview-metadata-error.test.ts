import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

function loadMetadataMethod(fetchImpl: ReturnType<typeof vi.fn>) {
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
  return (context as { __proto: { _fetchFilePreviewMetadata: (url: string) => Promise<unknown> } }).__proto
    ._fetchFilePreviewMetadata;
}

describe('file preview metadata errors', () => {
  it('preserves the API file-not-found message for a JSON 404 response', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 404,
      json: async () => ({ success: false, error: 'File not found' }),
    }));
    const fetchMetadata = loadMetadataMethod(fetchImpl);

    await expect(fetchMetadata.call({}, '/missing')).rejects.toThrow('File not found');
  });

  it('uses a safe generic error when a failed response is not JSON', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => {
        throw new SyntaxError('invalid JSON');
      },
    }));
    const fetchMetadata = loadMetadataMethod(fetchImpl);

    await expect(fetchMetadata.call({}, '/invalid')).rejects.toThrow('Failed to load file');
  });
});
