// @vitest-environment jsdom
/**
 * @fileoverview Guard: the jsdom environment can load Node builtins.
 *
 * Vitest 4 maps a `@vitest-environment jsdom` file onto Vite's CLIENT
 * environment, which browser-externalizes `node:*` "for browser compatibility".
 * Our tests are Node tests that want a DOM, and the shared `test/setup.ts`
 * builds a temp HOME out of node:fs/os/path, so that externalization broke
 * EVERY jsdom file in the repo: the externalized id round-tripped to the bare
 * specifier `node:` and threw ERR_UNKNOWN_BUILTIN_MODULE before a single test
 * was collected. Eleven files sat in that state having never run once.
 *
 * The fix is the `codeman:node-builtins-in-client` plugin in
 * config/vitest.config.ts (mirrored in vitest.ci.config.ts), which resolves
 * `node:*` as genuinely external so it loads natively in both environments.
 *
 * This file exists because that breakage is SILENT in the worst way — a failed
 * environment reports "0 test" rather than a failing assertion, so it reads as
 * a passing file at a glance. Here the same conditions are an explicit failure.
 */

import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

describe('jsdom environment', () => {
  it('provides DOM globals', () => {
    document.body.innerHTML = '<div id="probe">ok</div>';
    expect(document.getElementById('probe')?.textContent).toBe('ok');
    expect(typeof window).toBe('object');
  });

  it('loads the node builtins a statically-imported test needs', () => {
    // Static imports, exactly as the real jsdom suites write them — this is the
    // form Vite used to rewrite into the browser-external stub.
    expect(typeof readFileSync).toBe('function');
    expect(tmpdir().length).toBeGreaterThan(0);
    expect(join('a', 'b')).toMatch(/^a[/\\]b$/);
    expect(typeof vm.runInNewContext).toBe('function');
  });

  it('actually reads through node:fs, so the import is the real builtin', () => {
    // A browser-external stub throws on property access rather than returning a
    // working function, so a real read is what distinguishes them.
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
    expect(pkg.name).toBe('aicodeman');
  });

  it('ran the shared Node-only setup file (temp HOME is in place)', () => {
    // test/setup.ts is the module whose node: imports triggered the original
    // failure. If it were skipped, HOME would be the real one and the whole
    // suite's state-isolation guarantee would be gone.
    expect(process.env.VITEST).toBeTruthy();
    expect(process.env.HOME).toContain('codeman-vitest-');
  });
});
