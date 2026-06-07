import { afterEach, describe, expect, it, vi } from 'vitest';

describe('WebServer index.html template freshness', () => {
  afterEach(() => {
    vi.doUnmock('node:fs');
    vi.resetModules();
  });

  it('renders the current index.html template after assets are rebuilt', async () => {
    let template = '<html><head><title>Codeman</title></head><body><script src="app.old.js"></script></body></html>';

    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs')>();
      return {
        ...actual,
        readFileSync: vi.fn(
          (path: Parameters<typeof actual.readFileSync>[0], options?: Parameters<typeof actual.readFileSync>[1]) => {
            if (String(path).endsWith('/public/index.html')) return template;
            return actual.readFileSync(path, options);
          }
        ),
      };
    });

    const { WebServer } = await import('../src/web/server.js');
    const server = new WebServer(0, false, true, '127.0.0.1', 'fresh-host');

    template = '<html><head><title>Codeman</title></head><body><script src="app.new.js"></script></body></html>';

    const html = (server as unknown as { renderIndexHtml: () => string }).renderIndexHtml();
    expect(html).toContain('app.new.js');
    expect(html).not.toContain('app.old.js');
    expect(html).toContain('<title>codeman:fresh-host</title>');
  });
});
