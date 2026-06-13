/**
 * fetchHeadroomStatus (src/config/headroom-status.ts), COD-102.
 * Server-side probe of the proxy's /readyz + /stats. Port: N/A.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

afterEach(() => vi.restoreAllMocks());

const READYZ = { status: 'healthy', version: '0.25.0' };
const STATS = {
  summary: {
    api_requests: 118,
    compression: { requests_compressed: 89, avg_compression_pct: 74.4, total_tokens_removed: 16629 },
    cost: { total_saved_usd: 0.19 },
  },
};

function mockFetch(map: Record<string, { ok: boolean; json?: unknown }>) {
  return vi.fn(async (url: string) => {
    const hit = Object.entries(map).find(([k]) => url.includes(k));
    if (!hit) throw new Error('unexpected ' + url);
    const { ok, json } = hit[1];
    return { ok, json: async () => json } as unknown as Response;
  });
}

describe('fetchHeadroomStatus', () => {
  it('reports healthy with version and parsed stats', async () => {
    vi.stubGlobal('fetch', mockFetch({ '/readyz': { ok: true, json: READYZ }, '/stats': { ok: true, json: STATS } }));
    const { fetchHeadroomStatus } = await import('../../src/config/headroom-status.js');
    const s = await fetchHeadroomStatus('http://h:8787');
    expect(s.healthy).toBe(true);
    expect(s.version).toBe('0.25.0');
    expect(typeof s.latencyMs).toBe('number');
    expect(s.stats).toEqual({
      requests: 118,
      compressed: 89,
      compressedPct: 74.4,
      tokensSaved: 16629,
      costSavedUsd: 0.19,
    });
  });

  it('healthy with stats=null when /stats fails', async () => {
    vi.stubGlobal('fetch', mockFetch({ '/readyz': { ok: true, json: READYZ }, '/stats': { ok: false } }));
    const { fetchHeadroomStatus } = await import('../../src/config/headroom-status.js');
    const s = await fetchHeadroomStatus('http://h:8787');
    expect(s.healthy).toBe(true);
    expect(s.stats).toBeNull();
  });

  it('unhealthy when /readyz rejects', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('refused')));
    const { fetchHeadroomStatus } = await import('../../src/config/headroom-status.js');
    const s = await fetchHeadroomStatus('http://h:8787');
    expect(s.healthy).toBe(false);
    expect(s.stats).toBeNull();
  });

  it('disabled (healthy=false, no fetch) for empty proxyUrl', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    const { fetchHeadroomStatus } = await import('../../src/config/headroom-status.js');
    const s = await fetchHeadroomStatus('');
    expect(s.healthy).toBe(false);
    expect(f).not.toHaveBeenCalled();
  });
});
