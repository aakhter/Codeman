/**
 * Codex config.toml Headroom patch (src/config/codex-headroom-patch.ts), COD-98.
 * Tests the pure patchText/stripManagedRegions; file IO is covered by apply/remove
 * round-trip against a temp file. Port: N/A.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  patchText,
  stripManagedRegions,
  applyCodexHeadroomPatch,
  removeCodexHeadroomPatch,
} from '../../src/config/codex-headroom-patch.js';

const REAL = `[projects."/mnt/c/Users/aakht"]
trust_level = "trusted"

[tui.model_availability_nux]
"gpt-5.5" = 4
`;

const dirs: string[] = [];
function tmpConfig(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'codex-hr-'));
  dirs.push(dir);
  const p = join(dir, 'config.toml');
  writeFileSync(p, content);
  return p;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('patchText', () => {
  it('prepends top-level routing keys before any table and appends the provider table', () => {
    const out = patchText(REAL, 'http://192.168.55.175:8787');
    expect(out.indexOf('model_provider = "headroom"')).toBeLessThan(out.indexOf('[projects.'));
    expect(out).toContain('openai_base_url = "http://192.168.55.175:8787/v1"');
    expect(out.indexOf('[model_providers.headroom]')).toBeGreaterThan(out.indexOf('[tui.model_availability_nux]'));
    expect(out).toContain('base_url = "http://192.168.55.175:8787/v1"');
    expect(out).toContain('supports_websockets = true');
  });

  it('normalizes a trailing slash on the proxy URL to a single /v1', () => {
    const out = patchText(REAL, 'http://h:8787/');
    expect(out).toContain('openai_base_url = "http://h:8787/v1"');
    expect(out).not.toContain('8787//v1');
  });

  it('is idempotent (re-patching does not duplicate regions)', () => {
    const once = patchText(REAL, 'http://h:8787');
    const twice = patchText(once, 'http://h:8787');
    expect(twice).toBe(once);
  });

  it('round-trips: stripManagedRegions(patchText(x)) === x', () => {
    expect(stripManagedRegions(patchText(REAL, 'http://h:8787'))).toBe(REAL);
  });

  it('creates a patch-only file when the original is empty', () => {
    const out = patchText('', 'http://h:8787');
    expect(out).toContain('model_provider = "headroom"');
    expect(out).toContain('[model_providers.headroom]');
    expect(stripManagedRegions(out)).toBe('');
  });
});

describe('applyCodexHeadroomPatch / removeCodexHeadroomPatch', () => {
  it('applies then removes, restoring the original file byte-for-byte', () => {
    const p = tmpConfig(REAL);
    applyCodexHeadroomPatch('http://h:8787', p);
    const patched = readFileSync(p, 'utf8');
    expect(patched).toContain('model_provider = "headroom"');
    removeCodexHeadroomPatch(p);
    expect(readFileSync(p, 'utf8')).toBe(REAL);
  });

  it('apply is a no-op-safe re-run (idempotent on disk)', () => {
    const p = tmpConfig(REAL);
    applyCodexHeadroomPatch('http://h:8787', p);
    const first = readFileSync(p, 'utf8');
    applyCodexHeadroomPatch('http://h:8787', p);
    expect(readFileSync(p, 'utf8')).toBe(first);
  });

  it('remove on a clean file is a no-op', () => {
    const p = tmpConfig(REAL);
    removeCodexHeadroomPatch(p);
    expect(readFileSync(p, 'utf8')).toBe(REAL);
  });

  it('apply creates the file if missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-hr-'));
    dirs.push(dir);
    const p = join(dir, 'config.toml');
    expect(existsSync(p)).toBe(false);
    applyCodexHeadroomPatch('http://h:8787', p);
    expect(readFileSync(p, 'utf8')).toContain('[model_providers.headroom]');
  });
});
