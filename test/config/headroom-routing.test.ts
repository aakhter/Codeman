/**
 * Headroom routing config + health gate (src/config/headroom-routing.ts), COD-98.
 * Module reads env at call time (not module load), so each case sets env then calls.
 * Port: N/A (no server).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

const ENV_KEYS = ['HEADROOM_PROXY_URL', 'HEADROOM_ROUTE_CLAUDE', 'HEADROOM_ROUTE_CODEX'] as const;
const ORIG: Record<string, string | undefined> = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

function setEnv(env: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>) {
  for (const k of ENV_KEYS) {
    const v = env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

afterEach(async () => {
  for (const k of ENV_KEYS) {
    if (ORIG[k] === undefined) delete process.env[k];
    else process.env[k] = ORIG[k];
  }
  vi.restoreAllMocks();
  const mod = await import('../../src/config/headroom-routing.js');
  mod.__resetHealthCache();
});

describe('getHeadroomConfig', () => {
  it('defaults to ON with the baked-in proxy URL when nothing is set', async () => {
    setEnv({ HEADROOM_PROXY_URL: undefined, HEADROOM_ROUTE_CLAUDE: undefined, HEADROOM_ROUTE_CODEX: undefined });
    const { getHeadroomConfig } = await import('../../src/config/headroom-routing.js');
    expect(getHeadroomConfig()).toEqual({
      proxyUrl: 'http://192.168.55.175:8787',
      routeClaude: true,
      routeCodex: true,
    });
  });

  it('treats an empty HEADROOM_PROXY_URL as the master kill-switch', async () => {
    setEnv({ HEADROOM_PROXY_URL: '' });
    const { getHeadroomConfig } = await import('../../src/config/headroom-routing.js');
    expect(getHeadroomConfig().proxyUrl).toBe('');
  });

  it('parses per-type toggles case-insensitively', async () => {
    setEnv({ HEADROOM_ROUTE_CLAUDE: 'off', HEADROOM_ROUTE_CODEX: 'TRUE' });
    const { getHeadroomConfig } = await import('../../src/config/headroom-routing.js');
    const cfg = getHeadroomConfig();
    expect(cfg.routeClaude).toBe(false);
    expect(cfg.routeCodex).toBe(true);
  });

  it('falls back to the default for unrecognized toggle values', async () => {
    setEnv({ HEADROOM_ROUTE_CLAUDE: 'enabled', HEADROOM_ROUTE_CODEX: 'nope-not-valid' });
    const { getHeadroomConfig } = await import('../../src/config/headroom-routing.js');
    const cfg = getHeadroomConfig();
    expect(cfg.routeClaude).toBe(true); // unrecognized => default (true), NOT silently false
    expect(cfg.routeCodex).toBe(true);
  });
});

describe('isHeadroomHealthy', () => {
  it('returns true on a 2xx /readyz and caches within the TTL', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true } as Response);
    vi.stubGlobal('fetch', fetchMock);
    const { isHeadroomHealthy, __resetHealthCache } = await import('../../src/config/headroom-routing.js');
    __resetHealthCache();
    expect(await isHeadroomHealthy('http://h:8787', 1000)).toBe(true);
    expect(await isHeadroomHealthy('http://h:8787', 1500)).toBe(true); // cached, no 2nd fetch
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
  it('returns the proxy URL for a healthy Claude session', async () => {
    setEnv({ HEADROOM_PROXY_URL: 'http://h:8787', HEADROOM_ROUTE_CLAUDE: '1' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true } as Response));
    const { resolveHeadroomClaudeBaseUrl, __resetHealthCache } = await import('../../src/config/headroom-routing.js');
    __resetHealthCache();
    expect(await resolveHeadroomClaudeBaseUrl('claude')).toBe('http://h:8787');
  });

  it('returns undefined for non-claude modes', async () => {
    const { resolveHeadroomClaudeBaseUrl } = await import('../../src/config/headroom-routing.js');
    expect(await resolveHeadroomClaudeBaseUrl('codex')).toBeUndefined();
    expect(await resolveHeadroomClaudeBaseUrl('shell')).toBeUndefined();
  });

  it('returns undefined when Claude routing is disabled', async () => {
    setEnv({ HEADROOM_PROXY_URL: 'http://h:8787', HEADROOM_ROUTE_CLAUDE: 'off' });
    const { resolveHeadroomClaudeBaseUrl } = await import('../../src/config/headroom-routing.js');
    expect(await resolveHeadroomClaudeBaseUrl('claude')).toBeUndefined();
  });

  it('returns undefined when the proxy is unhealthy (fallback to direct API)', async () => {
    setEnv({ HEADROOM_PROXY_URL: 'http://h:8787', HEADROOM_ROUTE_CLAUDE: '1' });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('down')));
    const { resolveHeadroomClaudeBaseUrl, __resetHealthCache } = await import('../../src/config/headroom-routing.js');
    __resetHealthCache();
    expect(await resolveHeadroomClaudeBaseUrl('claude')).toBeUndefined();
  });
});
