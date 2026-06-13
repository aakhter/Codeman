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

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (ORIG[k] === undefined) delete process.env[k];
    else process.env[k] = ORIG[k];
  }
  vi.restoreAllMocks();
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
});
