/**
 * @fileoverview Headroom proxy routing config + health gate (COD-98/COD-102).
 *
 * Reads three keys from settings.json (evaluated at call time, not module load):
 *   - headroomProxyUrl    absent => baked-in default (feature ON); "" => kill-switch (OFF)
 *   - headroomRouteClaude default true; inject ANTHROPIC_BASE_URL for Claude sessions
 *   - headroomRouteCodex  default true; manage the ~/.codex/config.toml patch
 *
 * Routing is health-gated: a down proxy => sessions fall back to the direct API.
 *
 * @module config/headroom-routing
 */
import { readFileSync } from 'node:fs';
import type { SessionMode } from '../types/session.js';
import { dataPath } from './instance.js';
import { normalizeSettingsObject } from './settings.js';

const DEFAULT_PROXY_URL = 'http://192.168.55.175:8787';
const HEALTH_TTL_MS = 30_000;
const HEALTH_TIMEOUT_MS = 2_000;

export interface HeadroomConfig {
  /** Base proxy URL. Empty string = feature OFF. */
  proxyUrl: string;
  routeClaude: boolean;
  routeCodex: boolean;
}

function readSettings(): Record<string, unknown> {
  try {
    return normalizeSettingsObject(JSON.parse(readFileSync(dataPath('settings.json'), 'utf8')));
  } catch {
    return {};
  }
}

export function getHeadroomConfig(): HeadroomConfig {
  const s = readSettings();
  const rawUrl = s.headroomProxyUrl;
  return {
    // key present as string => use it ("" = off); absent/non-string => default (ON)
    proxyUrl: typeof rawUrl === 'string' ? rawUrl.trim() : DEFAULT_PROXY_URL,
    routeClaude: typeof s.headroomRouteClaude === 'boolean' ? s.headroomRouteClaude : true,
    routeCodex: typeof s.headroomRouteCodex === 'boolean' ? s.headroomRouteCodex : true,
  };
}

let _healthCache: { url: string; ok: boolean; at: number } | null = null;

/** Test-only: clear the cached health result. */
export function __resetHealthCache(): void {
  _healthCache = null;
}

/**
 * Cached probe of `<proxyUrl>/readyz`. `now` is injectable for deterministic
 * TTL tests; production callers omit it (defaults to Date.now()).
 */
export async function isHeadroomHealthy(proxyUrl: string, now: number = Date.now()): Promise<boolean> {
  if (!proxyUrl) return false;
  if (_healthCache && _healthCache.url === proxyUrl && now - _healthCache.at < HEALTH_TTL_MS) {
    return _healthCache.ok;
  }
  let ok = false;
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), HEALTH_TIMEOUT_MS);
    try {
      const res = await fetch(`${proxyUrl.replace(/\/$/, '')}/readyz`, { signal: ctl.signal });
      ok = res.ok;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    ok = false;
  }
  _healthCache = { url: proxyUrl, ok, at: now };
  return ok;
}

/**
 * Resolve the ANTHROPIC_BASE_URL to inject for a session, or undefined to leave
 * the session on the direct API. Claude-only; gated on config + health.
 */
export async function resolveHeadroomClaudeBaseUrl(mode: SessionMode): Promise<string | undefined> {
  if (mode !== 'claude') return undefined;
  const { proxyUrl, routeClaude } = getHeadroomConfig();
  if (!proxyUrl || !routeClaude) return undefined;
  return (await isHeadroomHealthy(proxyUrl)) ? proxyUrl : undefined;
}

/**
 * Whether a session of this mode would be routed through Headroom right now
 * (config + live health). Claude routes via env injection; Codex via the
 * config.toml patch; other modes never route. Used to label sessions in the UI.
 */
export async function resolveHeadroomRouted(mode: SessionMode): Promise<boolean> {
  if (mode === 'claude') return (await resolveHeadroomClaudeBaseUrl('claude')) !== undefined;
  if (mode === 'codex') {
    const { proxyUrl, routeCodex } = getHeadroomConfig();
    return !!proxyUrl && routeCodex && (await isHeadroomHealthy(proxyUrl));
  }
  return false;
}
export { reconcileCodexHeadroomPatch } from './codex-headroom-patch.js';
