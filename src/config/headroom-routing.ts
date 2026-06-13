/**
 * @fileoverview Headroom proxy routing config + health gate (COD-98).
 *
 * Reads three env vars (evaluated at call time, not module load):
 *   - HEADROOM_PROXY_URL   unset => baked-in default (feature ON); '' => kill-switch (OFF)
 *   - HEADROOM_ROUTE_CLAUDE default true; inject ANTHROPIC_BASE_URL for Claude sessions
 *   - HEADROOM_ROUTE_CODEX  default true; manage the ~/.codex/config.toml patch
 *
 * Routing is health-gated: a down proxy => sessions fall back to the direct API.
 *
 * @module config/headroom-routing
 */
import type { SessionMode } from '../types/session.js';

const DEFAULT_PROXY_URL = 'http://192.168.55.175:8787';
const HEALTH_TTL_MS = 30_000;
const HEALTH_TIMEOUT_MS = 2_000;

export interface HeadroomConfig {
  /** Base proxy URL. Empty string = feature OFF. */
  proxyUrl: string;
  routeClaude: boolean;
  routeCodex: boolean;
}

function parseBool(value: string | undefined, dflt: boolean): boolean {
  if (value === undefined || value.trim() === '') return dflt;
  return /^(1|true|yes|on)$/i.test(value.trim());
}

export function getHeadroomConfig(): HeadroomConfig {
  const raw = process.env.HEADROOM_PROXY_URL;
  // unset => default (ON); explicit empty string => OFF.
  const proxyUrl = raw === undefined ? DEFAULT_PROXY_URL : raw.trim();
  return {
    proxyUrl,
    routeClaude: parseBool(process.env.HEADROOM_ROUTE_CLAUDE, true),
    routeCodex: parseBool(process.env.HEADROOM_ROUTE_CODEX, true),
  };
}

// --- health gate (Task 2 adds the implementation) ---
