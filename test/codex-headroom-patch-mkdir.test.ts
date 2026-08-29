/**
 * COD-346: applyCodexHeadroomPatch must create ~/.codex when it does not exist.
 *
 * writeAtomic() wrote its temp file straight into dirname(configPath) without
 * ever creating that directory, so on a machine that has never run codex the
 * patch threw ENOENT. reconcileCodexHeadroomPatch() catches and logs, so no test
 * failed — it just meant the Headroom patch SILENTLY never applied. Every
 * server-booting browser test logged the ENOENT, which is how it was found.
 *
 * Port: N/A (pure filesystem).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { applyCodexHeadroomPatch } from '../src/config/codex-headroom-patch.js';

describe('applyCodexHeadroomPatch — missing parent directory', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cod346-headroom-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('creates the codex config directory instead of throwing ENOENT', () => {
    const configPath = join(root, '.codex', 'config.toml');
    expect(existsSync(join(root, '.codex'))).toBe(false);

    expect(() => applyCodexHeadroomPatch('http://127.0.0.1:8787', configPath)).not.toThrow();

    expect(existsSync(configPath)).toBe(true);
    expect(readFileSync(configPath, 'utf8')).toContain('model_providers.headroom');
  });

  it('creates nested missing parents and leaves the directory private', () => {
    const configPath = join(root, 'deep', 'nested', '.codex', 'config.toml');
    applyCodexHeadroomPatch('http://127.0.0.1:8787', configPath);
    expect(existsSync(configPath)).toBe(true);
    // The file itself is 0600; the directory holding it must not be world-readable,
    // since a codex config can carry provider settings.
    const mode = statSync(join(root, 'deep', 'nested', '.codex')).mode & 0o777;
    expect(mode & 0o077).toBe(0);
  });

  it('still patches normally when the directory already exists', () => {
    const configPath = join(root, 'config.toml');
    applyCodexHeadroomPatch('http://127.0.0.1:8787', configPath);
    applyCodexHeadroomPatch('http://127.0.0.1:9999', configPath);
    const text = readFileSync(configPath, 'utf8');
    // Idempotent: the second apply replaces rather than stacks a second region.
    expect(text.match(/model_providers\.headroom/g)).toHaveLength(1);
    expect(text).toContain('http://127.0.0.1:9999/v1');
    expect(text).not.toContain('8787');
  });
});
