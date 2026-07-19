/**
 * @fileoverview Reversible, idempotent Headroom patch of ~/.codex/config.toml (COD-98).
 *
 * Subscription Codex (auth_mode=chatgpt) ignores OPENAI_BASE_URL and hits
 * chatgpt.com directly, so routing it through Headroom requires config-level keys
 * (verified live in COD-98). TOML requires top-level keys before any [table], so
 * the patch has two sentinel-marked regions: top-level keys prepended at file
 * start, and the [model_providers.headroom] table appended at EOF. Both are
 * removable byte-for-byte via stripManagedRegions().
 *
 * @module config/codex-headroom-patch
 */
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { getHeadroomConfig, isHeadroomHealthy } from './headroom-routing.js';

const TOP_START = '# >>> codeman-headroom (managed) >>>';
const TOP_END = '# <<< codeman-headroom (managed) <<<';
const PROV_START = '# >>> codeman-headroom-provider (managed) >>>';
const PROV_END = '# <<< codeman-headroom-provider (managed) <<<';

// Tolerant, global, CRLF-aware removal (COD-228). Whitespace/blank-line drift,
// CRLF, duplicate copies, and orphan/legacy sentinel fragments must all clean.
// TOP: paired region + up to the 2 trailing newlines the patch adds (\n\n) — so
//   canonical (\n\n) and drifted (single \n) both clean; user blanks beyond 2 are kept.
// PROV: paired region + the single leading \n separator the patch adds + trailing \n.
// ORPHAN: any lone/unpaired managed sentinel LINE (START or END, either region).
const TOP_PAIR_RE =
  /# >>> codeman-headroom \(managed\) >>>[\s\S]*?# <<< codeman-headroom \(managed\) <<<(?:\r?\n){0,2}/g;
const PROV_PAIR_RE =
  /(?:\r?\n){0,1}# >>> codeman-headroom-provider \(managed\) >>>[\s\S]*?# <<< codeman-headroom-provider \(managed\) <<<(?:\r?\n){0,1}/g;
const ORPHAN_SENTINEL_RE =
  /^[ \t]*#[ \t]*[<>]{3}[ \t]*codeman-headroom(?:-provider)? \(managed\) [<>]{3}[ \t]*\r?\n?/gm;

/** Default path: $CODEX_HOME/config.toml or ~/.codex/config.toml. */
export function defaultCodexConfigPath(): string {
  const raw = process.env.CODEX_HOME;
  const home = raw !== undefined && raw.trim() !== '' ? raw : join(homedir(), '.codex');
  return join(home, 'config.toml');
}

/** Remove both managed regions, leaving non-codeman content untouched. */
export function stripManagedRegions(text: string): string {
  return text.replace(TOP_PAIR_RE, '').replace(PROV_PAIR_RE, '').replace(ORPHAN_SENTINEL_RE, '');
}

/** Pure: produce the patched file content for the given original + proxy URL. */
export function patchText(original: string, proxyUrl: string): string {
  const v1 = `${proxyUrl.replace(/\/+$/, '')}/v1`;
  const body = stripManagedRegions(original); // idempotent: drop any prior patch first
  const top = `${TOP_START}\n` + `model_provider = "headroom"\n` + `openai_base_url = "${v1}"\n` + `${TOP_END}\n\n`;
  const prov =
    `\n${PROV_START}\n` +
    `[model_providers.headroom]\n` +
    `name = "OpenAI via Headroom proxy"\n` +
    `base_url = "${v1}"\n` +
    `supports_websockets = true\n` +
    `${PROV_END}\n`;
  return top + body + prov;
}

function writeAtomic(path: string, content: string): void {
  const tmp = join(dirname(path), `.config.toml.headroom.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(tmp, content, { mode: 0o600 });
  renameSync(tmp, path);
}

/** Ensure the Headroom patch is present & current. Creates the file if missing. */
export function applyCodexHeadroomPatch(proxyUrl: string, configPath = defaultCodexConfigPath()): void {
  const original = existsSync(configPath) ? readFileSync(configPath, 'utf8') : '';
  writeAtomic(configPath, patchText(original, proxyUrl));
}

/** Ensure the Headroom patch is absent. No-op if the file is missing or already clean. */
export function removeCodexHeadroomPatch(configPath = defaultCodexConfigPath()): void {
  if (!existsSync(configPath)) return;
  const original = readFileSync(configPath, 'utf8');
  if (!original.includes(TOP_START) && !original.includes(PROV_START)) return;
  writeAtomic(configPath, stripManagedRegions(original));
}

/**
 * Reconcile the patch to the desired state = (proxy set && routeCodex && healthy).
 * Never throws into the caller — a bad config file logs and is skipped.
 */
export async function reconcileCodexHeadroomPatch(configPath = defaultCodexConfigPath()): Promise<void> {
  const { proxyUrl, routeCodex } = getHeadroomConfig();
  const desired = !!proxyUrl && routeCodex && (await isHeadroomHealthy(proxyUrl));
  try {
    if (desired) applyCodexHeadroomPatch(proxyUrl, configPath);
    else removeCodexHeadroomPatch(configPath);
  } catch (err) {
    console.warn('[headroom] codex config reconcile failed:', err);
  }
}
