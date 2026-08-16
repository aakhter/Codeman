#!/usr/bin/env node
/**
 * Browser-test exclusion check.
 *
 * `npm run test:ci` must never try to drive a real browser: CI runners (and any
 * clean checkout) have no chromium, so such a file dies with
 * `browserType.launch: Executable doesn't exist` and takes the whole suite with
 * it. `config/vitest.ci.config.ts` therefore excludes every browser-driven test
 * — but that list is maintained BY HAND, and a new browser test simply does not
 * appear in it unless someone remembers.
 *
 * That has now happened twice. COD-293 found `file-preview-source-download
 * .browser.test.ts` missing while its three siblings were listed, which meant
 * `test:ci` only passed on machines where someone had run `npx playwright
 * install`. It recurred immediately afterwards with `tab-rail-resize
 * .browser.test.ts`. Both were invisible locally and caught only by pointing the
 * browser caches at empty directories — a trick nobody runs by habit.
 *
 * Two deliberate design choices:
 *
 * 1. **Detection is by CONTENT, not filename.** Matching `*.browser.test.ts`
 *    would miss the five browser tests that predate that convention
 *    (`inline-rename`, `opencode-resize`, `webgl-fallback`,
 *    `terminal-copy-shortcut`, `codex-predictive-echo`). What actually makes a
 *    file dangerous is importing a browser driver, so that is what is tested.
 *
 * 2. **The exclusion side is answered by vitest itself**, via
 *    `vitest list --filesOnly`, rather than by re-implementing glob matching
 *    against the config's `exclude` array. Patterns there include `test/mobile/**`
 *    and `perf-*`; a hand-rolled matcher that disagreed with vitest by even one
 *    edge case would report a gap that does not exist, or miss one that does.
 *    Asking the real resolver cannot drift from the real behaviour.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TEST_DIR = join(ROOT, 'test');
const CI_CONFIG = join('config', 'vitest.ci.config.ts');

/** Importing one of these is what makes a test need a real browser binary. */
const BROWSER_DRIVER = /\bfrom\s+['"](playwright|playwright-core|puppeteer)['"]|\brequire\(\s*['"](playwright|playwright-core|puppeteer)['"]\s*\)/;

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(path));
    else if (entry.isFile() && entry.name.endsWith('.test.ts')) out.push(path);
  }
  return out;
}

const browserTests = walk(TEST_DIR)
  .filter((file) => BROWSER_DRIVER.test(readFileSync(file, 'utf8')))
  .map((file) => relative(ROOT, file).split(sep).join('/'))
  .sort();

let collected;
try {
  collected = execFileSync('npx', ['vitest', 'list', '--config', CI_CONFIG, '--filesOnly'], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
} catch (err) {
  console.error('✗ could not enumerate the CI test set via `vitest list`.');
  console.error(err.stderr ? err.stderr.toString() : String(err));
  process.exit(1);
}

// `vitest list` prints one repo-relative path per line; ignore any stray blank
// or decorative lines rather than assuming the format is pristine.
const ciFiles = new Set(
  collected
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.endsWith('.test.ts'))
    .map((line) => line.replace(/^\.\//, ''))
);

const leaked = browserTests.filter((file) => ciFiles.has(file));

if (leaked.length > 0) {
  console.error(`✗ ${leaked.length} browser-driven test file(s) are NOT excluded from ${CI_CONFIG}:\n`);
  for (const file of leaked) console.error(`    ${file}`);
  console.error(`
These import a browser driver, so on a runner with no chromium they fail with
"browserType.launch: Executable doesn't exist" and take the suite down. Add each
to the \`exclude\` array in ${CI_CONFIG}.

They may well pass on this machine — that is the trap. To reproduce a clean
runner locally:
  PLAYWRIGHT_BROWSERS_PATH=\$(mktemp -d) PUPPETEER_CACHE_DIR=\$(mktemp -d) npm run test:ci`);
  process.exit(1);
}

console.log(
  `✓ all ${browserTests.length} browser-driven test files are excluded from the CI suite (${ciFiles.size} files collected)`
);
