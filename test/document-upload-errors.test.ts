/**
 * @fileoverview Document-upload batch error reporting regression tests (COD-292).
 *
 * Loads the plain browser mixin in a Node VM and exercises it through a small
 * CodemanApp stub. Port: N/A.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

type UploadApp = {
  activeSessionId: string;
  _uploadConcurrency: number;
  _uploadAndInsertDocuments(files: Array<{ name: string }>): Promise<void>;
  _uploadDocument(sessionId: string, file: { name: string }): Promise<string>;
  sendInput: ReturnType<typeof vi.fn>;
  showToast: ReturnType<typeof vi.fn>;
};

function loadMixin(options: { fetch?: ReturnType<typeof vi.fn>; warn?: ReturnType<typeof vi.fn> } = {}) {
  const source = readFileSync(resolve(import.meta.dirname, '../src/web/public/document-input.js'), 'utf8');
  class CodemanApp {}
  const context = vm.createContext({
    CodemanApp,
    FormData: class {
      append() {}
    },
    fetch: options.fetch,
    console: { warn: options.warn || vi.fn() },
  });
  vm.runInContext(`${source}\nglobalThis.__proto = CodemanApp.prototype;`, context, {
    filename: 'document-input.js',
  });
  return context.__proto as UploadApp;
}

function makeApp(proto: UploadApp): UploadApp {
  const app = Object.create(proto) as UploadApp;
  app.activeSessionId = 'session-1';
  app._uploadConcurrency = 3;
  app.sendInput = vi.fn().mockResolvedValue(undefined);
  app.showToast = vi.fn();
  return app;
}

describe('document upload error reporting', () => {
  it('reports the lowest-index failure with its filename despite out-of-order completion', async () => {
    const warn = vi.fn();
    const app = makeApp(loadMixin({ warn }));
    const files = [{ name: 'first.pdf' }, { name: 'second.pdf' }, { name: 'third.pdf' }, { name: 'fourth.pdf' }];
    const delays: Record<string, number> = {
      'first.pdf': 30,
      'second.pdf': 5,
      'third.pdf': 10,
      'fourth.pdf': 1,
    };
    app._uploadDocument = vi.fn(async (_sessionId, file) => {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, delays[file.name]));
      if (file.name === 'first.pdf') throw new Error('first reason');
      if (file.name === 'second.pdf') throw new Error('second reason');
      return `.codeman-attachments/${file.name}`;
    });

    await app._uploadAndInsertDocuments(files);

    expect(app.sendInput).toHaveBeenCalledWith(
      '[Attachments: ".codeman-attachments/third.pdf", ".codeman-attachments/fourth.pdf"]'
    );
    expect(app.showToast).toHaveBeenLastCalledWith('2 documents ready · 2 failed: first.pdf — first reason', 'info');
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('normalizes and caps the entire final toast while retaining batch and first-failure context', async () => {
    const app = makeApp(loadMixin());
    const files = [
      { name: `bad\n${'f'.repeat(180)}.pdf` },
      ...Array.from({ length: 10 }, (_, index) => ({ name: `ok-${index}.pdf` })),
    ];
    app._uploadDocument = vi.fn(async (_sessionId, file) => {
      if (file.name.startsWith('bad')) throw new Error(`reason\r\n${'x'.repeat(200)}`);
      return `.codeman-attachments/${file.name}`;
    });

    await app._uploadAndInsertDocuments(files);

    const finalMessage = app.showToast.mock.calls.at(-1)?.[0] as string;
    expect(finalMessage.length).toBeLessThanOrEqual(160);
    expect(finalMessage).not.toMatch(/[\r\n]/);
    expect(finalMessage).toContain('9 documents ready');
    expect(finalMessage).toContain('1 failed');
    expect(finalMessage).toContain('max 10 per batch');
    expect(finalMessage).toContain('bad f');
    expect(finalMessage).toContain('reason');
  });

  it('uses a generic HTTP status for a non-JSON failure response', async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      json: vi.fn().mockRejectedValue(new SyntaxError('invalid JSON containing proxy response details')),
    });
    const app = makeApp(loadMixin({ fetch }));

    await expect(app._uploadDocument('session-1', { name: 'report.pdf' })).rejects.toThrow('HTTP 502');
  });

  it('uses a generic upload failure for a non-JSON success response', async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockRejectedValue(new SyntaxError('unexpected response fragment')),
    });
    const app = makeApp(loadMixin({ fetch }));

    await expect(app._uploadDocument('session-1', { name: 'report.pdf' })).rejects.toThrow('Upload failed');
  });

  it.each([
    { success: true },
    { success: true, data: {} },
    { success: true, data: { agentPath: '' } },
    { success: true, data: { agentPath: 42 } },
  ])('rejects a malformed successful response envelope: %j', async (body) => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue(body),
    });
    const app = makeApp(loadMixin({ fetch }));

    await expect(app._uploadDocument('session-1', { name: 'report.pdf' })).rejects.toThrow('Upload failed');
  });
});
