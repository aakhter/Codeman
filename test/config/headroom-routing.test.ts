/**
 * Headroom routing config + health gate (src/config/headroom-routing.ts), COD-98/COD-102.
 * getHeadroomConfig now reads settings.json (not env vars).
 * isHeadroomHealthy takes proxyUrl directly -- no config read, no change needed.
 * Port: N/A (no server).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDirs: string[] = [];
function withSettings(obj: Record<string, unknown> | null): string {
  const dir = mkdtempSync(join(tmpdir(), 'hr-settings-'));
  dataDirs.push(dir);
  if (obj !== null) writeFileSync(join(dir, 'settings.json'), JSON.stringify(obj));
  process.env.CODEMAN_DATA_DIR = dir;
  return dir;
}

const origDataDir = process.env.CODEMAN_DATA_DIR;

afterEach(async () => {
  if (origDataDir === undefined) delete process.env.CODEMAN_DATA_DIR;
  else process.env.CODEMAN_DATA_DIR = origDataDir;
  for (const d of dataDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  const mod = await import('../../src/config/headroom-routing.js');
  mod.__resetHealthCache();
});

describe('getHeadroomConfig (settings-based)', () => {
  afterEach(() => {
    vi.resetModules();
  });

  it('defaults to ON with the baked-in proxy URL when settings.json is absent', async () => {
    withSettings(null);
    const { getHeadroomConfig } = await import('../../src/config/headroom-routing.js');
    expect(getHeadroomConfig()).toEqual({
      proxyUrl: 'http://192.168.55.175:8787',
      routeClaude: true,
      routeCodex: true,
    });
  });

  it('reads values from settings.json', async () => {
    withSettings({ headroomProxyUrl: 'http://h:9000', headroomRouteClaude: false, headroomRouteCodex: true });
    const { getHeadroomConfig } = await import('../../src/config/headroom-routing.js');
    expect(getHeadroomConfig()).toEqual({ proxyUrl: 'http://h:9000', routeClaude: false, routeCodex: true });
  });

  it('treats an empty headroomProxyUrl as the kill-switch', async () => {
    withSettings({ headroomProxyUrl: '' });
    const { getHeadroomConfig } = await import('../../src/config/headroom-routing.js');
    expect(getHeadroomConfig().proxyUrl).toBe('');
  });

  it('falls back to defaults for missing keys and malformed file', async () => {
    const dir = withSettings({ headroomRouteClaude: false });
    let { getHeadroomConfig } = await import('../../src/config/headroom-routing.js');
    expect(getHeadroomConfig()).toEqual({
      proxyUrl: 'http://192.168.55.175:8787',
      routeClaude: false,
      routeCodex: true,
    });
    vi.resetModules();
    writeFileSync(join(dir, 'settings.json'), '{ not json');
    ({ getHeadroomConfig } = await import('../../src/config/headroom-routing.js'));
    expect(getHeadroomConfig()).toEqual({
      proxyUrl: 'http://192.168.55.175:8787',
      routeClaude: true,
      routeCodex: true,
    });
  });
});

describe('isHeadroomHealthy', () => {
  it('returns true on a 2xx /readyz and caches within the TTL', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true } as Response);
    vi.stubGlobal('fetch', fetchMock);
    const { isHeadroomHealthy, __resetHealthCache } = await import('../../src/config/headroom-routing.js');
    __resetHealthCache();
    expect(await isHeadroomHealthy('http://h:8787', 1000)).toBe(true);
    expect(await isHeadroomHealthy('http://h:8787', 1500)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://h:8787/readyz',
      expect.objectContaining({ signal: expect.anything() })
    );
  });

  it('re-probes after the TTL expires', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true } as Response);
    vi.stubGlobal('fetch', fetchMock);
    const { isHeadroomHealthy, __resetHealthCache } = await import('../../src/config/headroom-routing.js');
    __resetHealthCache();
    await isHeadroomHealthy('http://h:8787', 1000);
    await isHeadroomHealthy('http://h:8787', 1000 + 31_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('returns false when fetch rejects (proxy down/timeout)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    const { isHeadroomHealthy, __resetHealthCache } = await import('../../src/config/headroom-routing.js');
    __resetHealthCache();
    expect(await isHeadroomHealthy('http://h:8787', 2000)).toBe(false);
  });

  it('returns false for an empty proxy URL without fetching', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { isHeadroomHealthy, __resetHealthCache } = await import('../../src/config/headroom-routing.js');
    __resetHealthCache();
    expect(await isHeadroomHealthy('', 1000)).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('resolveHeadroomClaudeBaseUrl', () => {
  afterEach(() => {
    vi.resetModules();
  });

  it('returns the proxy URL for a healthy Claude session', async () => {
    withSettings({ headroomProxyUrl: 'http://h:8787', headroomRouteClaude: true });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true } as Response));
    const { resolveHeadroomClaudeBaseUrl, __resetHealthCache } = await import('../../src/config/headroom-routing.js');
    __resetHealthCache();
    expect(await resolveHeadroomClaudeBaseUrl('claude')).toBe('http://h:8787');
  });

  it('returns undefined for non-claude modes', async () => {
    withSettings({ headroomProxyUrl: 'http://h:8787', headroomRouteClaude: true });
    const { resolveHeadroomClaudeBaseUrl } = await import('../../src/config/headroom-routing.js');
    expect(await resolveHeadroomClaudeBaseUrl('codex')).toBeUndefined();
    expect(await resolveHeadroomClaudeBaseUrl('shell')).toBeUndefined();
  });

  it('returns undefined when Claude routing is disabled', async () => {
    withSettings({ headroomProxyUrl: 'http://h:8787', headroomRouteClaude: false });
    const { resolveHeadroomClaudeBaseUrl } = await import('../../src/config/headroom-routing.js');
    expect(await resolveHeadroomClaudeBaseUrl('claude')).toBeUndefined();
  });

  it('returns undefined when the proxy is unhealthy (fallback to direct API)', async () => {
    withSettings({ headroomProxyUrl: 'http://h:8787', headroomRouteClaude: true });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('down')));
    const { resolveHeadroomClaudeBaseUrl, __resetHealthCache } = await import('../../src/config/headroom-routing.js');
    __resetHealthCache();
    expect(await resolveHeadroomClaudeBaseUrl('claude')).toBeUndefined();
  });
});

describe('resolveHeadroomRouted', () => {
  afterEach(() => {
    vi.resetModules();
  });

  it('true for healthy claude and codex, false for shell', async () => {
    withSettings({ headroomProxyUrl: 'http://h:8787', headroomRouteClaude: true, headroomRouteCodex: true });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true } as Response));
    const m = await import('../../src/config/headroom-routing.js');
    m.__resetHealthCache();
    expect(await m.resolveHeadroomRouted('claude')).toBe(true);
    expect(await m.resolveHeadroomRouted('codex')).toBe(true);
    expect(await m.resolveHeadroomRouted('shell')).toBe(false);
  });

  it('false when the proxy is unhealthy', async () => {
    withSettings({ headroomProxyUrl: 'http://h:8787' });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('down')));
    const m = await import('../../src/config/headroom-routing.js');
    m.__resetHealthCache();
    expect(await m.resolveHeadroomRouted('claude')).toBe(false);
    expect(await m.resolveHeadroomRouted('codex')).toBe(false);
  });

  it('false for codex when routeCodex is off', async () => {
    withSettings({ headroomProxyUrl: 'http://h:8787', headroomRouteCodex: false });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true } as Response));
    const m = await import('../../src/config/headroom-routing.js');
    m.__resetHealthCache();
    expect(await m.resolveHeadroomRouted('codex')).toBe(false);
  });
});
