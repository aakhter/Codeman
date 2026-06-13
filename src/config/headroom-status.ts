/**
 * @fileoverview Server-side Headroom status probe (COD-102). Fetches the proxy's
 * /readyz + /stats from the codeman server (not the browser) so the panel works
 * even when codeman is HTTPS-via-tunnel and the proxy is plain-HTTP on the LAN.
 * @module config/headroom-status
 */

export interface HeadroomStats {
  requests: number;
  compressed: number;
  compressedPct: number;
  tokensSaved: number;
  costSavedUsd: number;
  savingsPct: number;
  cacheSavedUsd: number;
  bestPct: number;
}

export interface HeadroomStatus {
  healthy: boolean;
  version: string | null;
  latencyMs: number | null;
  stats: HeadroomStats | null;
}

const PROBE_TIMEOUT_MS = 2_000;

async function getJson(url: string): Promise<unknown> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function parseStats(body: unknown): HeadroomStats | null {
  const s = (body as { summary?: Record<string, unknown> } | null)?.summary;
  if (!s) return null;
  const c = (s.compression ?? {}) as Record<string, number>;
  const cost = (s.cost ?? {}) as Record<string, unknown>;
  const bd = (cost.breakdown ?? {}) as Record<string, number>;
  return {
    requests: Number(s.api_requests ?? 0),
    compressed: Number(c.requests_compressed ?? 0),
    compressedPct: Number(c.avg_compression_pct ?? 0),
    tokensSaved: Number(c.total_tokens_removed ?? 0),
    costSavedUsd: Number((cost.total_saved_usd as number) ?? 0),
    savingsPct: Number((cost.savings_pct as number) ?? 0),
    cacheSavedUsd: Number(bd.cache_savings_usd ?? 0),
    bestPct: Number(c.best_compression_pct ?? 0),
  };
}

export async function fetchHeadroomStatus(proxyUrl: string): Promise<HeadroomStatus> {
  if (!proxyUrl) return { healthy: false, version: null, latencyMs: null, stats: null };
  const base = proxyUrl.replace(/\/+$/, '');
  const started = Date.now();
  let version: string | null = null;
  try {
    const ready = (await getJson(`${base}/readyz`)) as { version?: string } | null;
    version = ready?.version ?? null;
  } catch {
    return { healthy: false, version: null, latencyMs: null, stats: null };
  }
  const latencyMs = Date.now() - started;
  let stats: HeadroomStats | null = null;
  try {
    stats = parseStats(await getJson(`${base}/stats`));
  } catch {
    stats = null;
  }
  return { healthy: true, version, latencyMs, stats };
}
