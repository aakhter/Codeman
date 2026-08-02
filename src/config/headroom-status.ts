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
  /** Proxy-provided request attribution. These are proxy-wide, not per-Codeman-session counters. */
  attribution?: HeadroomAttribution;
}

export interface HeadroomAgentUsage {
  agent: string;
  label: string;
  source: string;
  requests: number;
  tokensSaved: number;
  savingsPct: number;
  providers: Record<string, number>;
}

/** Bounded subset of Headroom's top-level `agent_usage` and `requests` fields. */
export interface HeadroomAttribution {
  agents: HeadroomAgentUsage[];
  providers: Record<string, number>;
  models: Record<string, number>;
  stacks: Record<string, number>;
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

function numericBuckets(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, raw]) => {
      const count = Number(raw);
      return Number.isFinite(count) ? [[key, count]] : [];
    })
  );
}

function parseAttribution(body: Record<string, unknown>): HeadroomAttribution | undefined {
  const requests = (body.requests ?? {}) as Record<string, unknown>;
  const agentUsage = (body.agent_usage ?? {}) as Record<string, unknown>;
  const agents = Array.isArray(agentUsage.agents)
    ? agentUsage.agents.flatMap((raw) => {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
        const item = raw as Record<string, unknown>;
        if (typeof item.agent !== 'string' || !item.agent) return [];
        return [
          {
            agent: item.agent,
            label: typeof item.label === 'string' && item.label ? item.label : item.agent,
            source: typeof item.source === 'string' && item.source ? item.source : 'unknown',
            requests: Number(item.requests ?? 0),
            tokensSaved: Number(item.tokens_saved ?? 0),
            savingsPct: Number(item.savings_percent ?? 0),
            providers: numericBuckets(item.providers),
          },
        ];
      })
    : [];
  const providers = numericBuckets(requests.by_provider);
  const models = numericBuckets(requests.by_model);
  const stacks = numericBuckets(requests.by_stack);
  return agents.length || Object.keys(providers).length || Object.keys(models).length || Object.keys(stacks).length
    ? { agents, providers, models, stacks }
    : undefined;
}

function parseStats(body: unknown): HeadroomStats | null {
  const payload = body as Record<string, unknown> | null;
  const s = payload?.summary as Record<string, unknown> | undefined;
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
    attribution: parseAttribution(payload ?? {}),
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
