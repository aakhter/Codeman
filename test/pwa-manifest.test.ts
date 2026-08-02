/**
 * @fileoverview Regression coverage for the server-authoritative PWA manifest.
 *
 * Android installation metadata must use the same persisted branding and server
 * hostname identity as the normal HTML title, never client-local state.
 *
 * Port: in-memory Fastify injection only.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebServer } from '../src/web/server.js';

vi.mock('../src/mux-factory.js', async () => {
  const { EventEmitter } = await import('node:events');
  class TestMux extends EventEmitter {
    destroy() {}
  }
  return { createMultiplexer: () => new TestMux() };
});

const originalDataDir = process.env.CODEMAN_DATA_DIR;

afterEach(() => {
  if (originalDataDir === undefined) delete process.env.CODEMAN_DATA_DIR;
  else process.env.CODEMAN_DATA_DIR = originalDataDir;
});

type ManifestResponse = {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  json(): unknown;
};

type InjectServer = {
  setupRoutes(): Promise<void>;
  app: {
    inject(options: { url: string }): Promise<ManifestResponse>;
    close(): Promise<void>;
  };
};

async function getManifest(displayName: string | undefined, titleHostname: string): Promise<ManifestResponse> {
  const dataDir = mkdtempSync(join(tmpdir(), 'codeman-pwa-manifest-'));
  process.env.CODEMAN_DATA_DIR = dataDir;
  if (displayName !== undefined) writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({ displayName }));

  const server = new WebServer(0, false, true, '127.0.0.1', titleHostname);
  const injectServer = server as unknown as InjectServer;
  await injectServer.setupRoutes();
  try {
    return await injectServer.app.inject({ url: '/manifest.json' });
  } finally {
    await injectServer.app.close();
  }
}

describe('server-authoritative PWA manifest (COD-256)', () => {
  it('uses the default server title identity and preserves existing PWA fields', async () => {
    const response = await getManifest(undefined, 'android-box');

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toEqual(expect.stringContaining('application/manifest+json'));
    expect(response.headers['cache-control']).not.toEqual(expect.stringContaining('immutable'));
    expect(response.headers['cache-control']).toEqual(expect.stringMatching(/no-cache|must-revalidate/));

    expect(response.json()).toEqual({
      name: 'codeman:android-box',
      short_name: 'codeman:android-box',
      description: 'Claude Code session manager',
      start_url: '/',
      display: 'standalone',
      orientation: 'any',
      background_color: '#0a0a0a',
      theme_color: '#0a0a0a',
      icons: [
        { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
        { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
      ],
    });
  });

  it('uses persisted custom branding and safely serializes hostile-looking identity text', async () => {
    const response = await getManifest('Workbench \u2028</script>', '<server>&');

    const body = response.body;
    expect(body).not.toContain('</script>');
    expect(body).not.toContain('\u2028');
    expect(response.json()).toMatchObject({
      name: 'Workbench \u2028</script>:<server>&',
      short_name: 'Workbench \u2028</script>:<server>&',
    });
  });
});
