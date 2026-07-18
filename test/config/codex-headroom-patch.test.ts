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
  reconcileCodexHeadroomPatch,
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

  it('normalizes multiple trailing slashes to a single /v1', () => {
    const out = patchText(REAL, 'http://h:8787//');
    expect(out).toContain('openai_base_url = "http://h:8787/v1"');
    expect(out).not.toContain('8787//v1');
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

// COD-228: sentinel-region matching must tolerate whitespace/newline drift,
// collapse duplicate copies, tolerate CRLF, and sweep orphan/legacy fragments,
// while preserving user content byte-for-byte.
describe('COD-228 stripManagedRegions robustness', () => {
  const URL = 'http://h:8787';
  // Public sentinels (mirror the module-private constants; stable markers).
  const TOP_START = '# >>> codeman-headroom (managed) >>>';
  const TOP_END = '# <<< codeman-headroom (managed) <<<';
  const PROV_START = '# >>> codeman-headroom-provider (managed) >>>';
  const PROV_END = '# <<< codeman-headroom-provider (managed) <<<';

  const countTop = (s: string) => (s.match(/model_provider = "headroom"/g) || []).length;
  const countProv = (s: string) => (s.match(/\[model_providers\.headroom\]/g) || []).length;
  const hasSentinel = (s: string) => s.includes('codeman-headroom');
  const userTablesIntact = (s: string) => {
    expect(s).toContain('[projects."/mnt/c/Users/aakht"]');
    expect(s).toContain('[tui.model_availability_nux]');
  };

  // Split a canonical patch into its top region, the user body (REAL), and the
  // provider region — without hardcoding managed internals.
  function partsOf(url = URL) {
    const patched = patchText(REAL, url);
    const idx = patched.indexOf(REAL);
    return { patched, top: patched.slice(0, idx), prov: patched.slice(idx + REAL.length) };
  }

  it('collapses exact duplicate regions back to REAL, and re-patch yields exactly one of each', () => {
    const { top, prov } = partsOf();
    const dup = top + top + REAL + prov + prov; // simulates the pre-fix double-apply bug
    expect(countTop(dup)).toBe(2);
    expect(countProv(dup)).toBe(2);

    const stripped = stripManagedRegions(dup);
    expect(stripped).toBe(REAL);
    userTablesIntact(stripped);

    const repatched = patchText(dup, URL);
    expect(countTop(repatched)).toBe(1);
    expect(countProv(repatched)).toBe(1);
  });

  it('tolerates single-newline drift after the top region (1 vs 2 trailing newlines)', () => {
    const patched = patchText(REAL, URL);
    const drift = patched.replace(`${TOP_END}\n\n`, `${TOP_END}\n`);
    expect(drift).not.toBe(patched);

    expect(stripManagedRegions(drift)).toBe(REAL);
    // Re-patching a drifted file must not prepend a second top block.
    const repatched = patchText(drift, URL);
    expect(countTop(repatched)).toBe(1);
    expect(countProv(repatched)).toBe(1);
  });

  it('preserves the user blank line inside REAL through a strip round-trip', () => {
    const stripped = stripManagedRegions(patchText(REAL, URL));
    expect(stripped).toBe(REAL);
    expect(stripped).toContain('trust_level = "trusted"\n\n[tui.model_availability_nux]');
  });

  it('consumes only the patch newlines, preserving user blank lines beyond 2 (bound {0,2})', () => {
    const patched = patchText(REAL, URL);
    const withExtra = patched.replace(`${TOP_END}\n\n`, `${TOP_END}\n\n\n`);
    // The patch's own up-to-2 newlines are consumed; the extra user blank survives.
    expect(stripManagedRegions(withExtra)).toBe(`\n${REAL}`);
  });

  it('removes both managed regions from a CRLF file', () => {
    const crlf = patchText(REAL, URL).replace(/\n/g, '\r\n');
    const stripped = stripManagedRegions(crlf);
    expect(stripped).not.toContain(TOP_START);
    expect(stripped).not.toContain(TOP_END);
    expect(stripped).not.toContain(PROV_START);
    expect(stripped).not.toContain(PROV_END);
    expect(hasSentinel(stripped)).toBe(false);
    userTablesIntact(stripped);
  });

  it('strips a lone top block with no provider table', () => {
    const { top } = partsOf();
    const fileA = top + REAL; // top region present, no provider region
    expect(stripManagedRegions(fileA)).toBe(REAL);
  });

  it('sweeps an orphan (unpaired) START sentinel line', () => {
    const fileB = `${TOP_START}\n` + REAL; // orphan START, no END
    const stripped = stripManagedRegions(fileB);
    expect(stripped).toBe(REAL);
    expect(hasSentinel(stripped)).toBe(false);
  });

  it('sweeps an orphan (unpaired) END sentinel line', () => {
    const fileC = REAL + `${PROV_END}\n`; // orphan END, no START
    const stripped = stripManagedRegions(fileC);
    expect(stripped).toBe(REAL);
    expect(hasSentinel(stripped)).toBe(false);
  });
});

describe('COD-228 removeCodexHeadroomPatch on malformed states', () => {
  const URL = 'http://h:8787';
  const TOP_START = '# >>> codeman-headroom (managed) >>>';
  const TOP_END = '# <<< codeman-headroom (managed) <<<';
  const hasSentinel = (s: string) => s.includes('codeman-headroom');

  it('removes an orphan START-only fragment, leaving user content intact', () => {
    const p = tmpConfig(`${TOP_START}\n` + REAL);
    removeCodexHeadroomPatch(p);
    const out = readFileSync(p, 'utf8');
    expect(hasSentinel(out)).toBe(false);
    expect(out).toContain('[projects."/mnt/c/Users/aakht"]');
    expect(out).toContain('[tui.model_availability_nux]');
  });

  it('removes a drifted patch (single trailing newline) completely', () => {
    const drift = patchText(REAL, URL).replace(`${TOP_END}\n\n`, `${TOP_END}\n`);
    const p = tmpConfig(drift);
    removeCodexHeadroomPatch(p);
    const out = readFileSync(p, 'utf8');
    expect(hasSentinel(out)).toBe(false);
    expect(out).toContain('trust_level = "trusted"');
  });

  it('removes duplicated regions completely', () => {
    const patched = patchText(REAL, URL);
    const idx = patched.indexOf(REAL);
    const top = patched.slice(0, idx);
    const prov = patched.slice(idx + REAL.length);
    const dup = top + top + REAL + prov + prov;
    const p = tmpConfig(dup);
    removeCodexHeadroomPatch(p);
    const out = readFileSync(p, 'utf8');
    expect(hasSentinel(out)).toBe(false);
    expect(out).toContain('[projects."/mnt/c/Users/aakht"]');
  });
});

describe('COD-228 idempotent apply on a drifted file', () => {
  const URL = 'http://h:8787';
  const TOP_END = '# <<< codeman-headroom (managed) <<<';

  it('apply on a drifted file yields exactly one of each region and is byte-stable', () => {
    const drift = patchText(REAL, URL).replace(`${TOP_END}\n\n`, `${TOP_END}\n`);
    const p = tmpConfig(drift);
    applyCodexHeadroomPatch(URL, p);
    const first = readFileSync(p, 'utf8');
    expect((first.match(/model_provider = "headroom"/g) || []).length).toBe(1);
    expect((first.match(/\[model_providers\.headroom\]/g) || []).length).toBe(1);
    applyCodexHeadroomPatch(URL, p);
    const second = readFileSync(p, 'utf8');
    expect(second).toBe(first);
  });
});

describe('COD-228 reconcile disable removes the patch from disk', () => {
  it('reconcile with codex routing off (kill-switch) removes the patch, no health check', async () => {
    const prev = process.env.CODEMAN_DATA_DIR;
    const dataDir = mkdtempSync(join(tmpdir(), 'codex-hr-data-'));
    dirs.push(dataDir);
    // Empty proxyUrl => desired=false short-circuits BEFORE isHeadroomHealthy (no network).
    writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({ headroomProxyUrl: '' }));
    process.env.CODEMAN_DATA_DIR = dataDir;
    try {
      const p = tmpConfig(patchText(REAL, 'http://h:8787'));
      await reconcileCodexHeadroomPatch(p);
      const out = readFileSync(p, 'utf8');
      expect(out).not.toContain('codeman-headroom');
      expect(out).toBe(REAL);
    } finally {
      if (prev === undefined) delete process.env.CODEMAN_DATA_DIR;
      else process.env.CODEMAN_DATA_DIR = prev;
    }
  });
});
