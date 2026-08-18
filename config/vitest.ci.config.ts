import { resolve } from 'node:path';
import { defineConfig, configDefaults } from 'vitest/config';

const root = resolve(import.meta.dirname, '..');

/**
 * CI test config — same as vitest.config.ts but EXCLUDES the browser-driven
 * mobile suite (test/mobile/**). Those are Playwright visual-regression tests
 * that need a live server + chromium + environment-specific PNG baselines, so
 * they are run/maintained separately and are not part of the CI gate.
 *
 * Keep the rest in sync with config/vitest.config.ts.
 */
export default defineConfig({
  // See config/vitest.config.ts for why this exists: without it every
  // `@vitest-environment jsdom` file dies at env setup with
  // "No such built-in module: node:" and reports "0 test" rather than failing.
  plugins: [
    {
      name: 'codeman:node-builtins-in-client',
      enforce: 'pre' as const,
      resolveId(id: string) {
        if (id.startsWith('node:')) return { id, external: true };
        return null;
      },
    },
  ],
  test: {
    root,
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    exclude: [
      ...configDefaults.exclude,
      'test/mobile/**', // browser/visual (Playwright + chromium)
      'test/perf-*.test.ts', // timing-sensitive perf benchmarks (flaky in CI)
      'test/inline-rename.test.ts', // browser (Playwright)
      'test/opencode-resize.test.ts', // browser (Playwright)
      'test/webgl-fallback.test.ts', // browser (Playwright)
      'test/file-browser-session-preview.browser.test.ts', // browser (Playwright + chromium)
      // COD-293: this one was missing while its three `.browser.test.ts` siblings were
      // all listed, so `test:ci` could only pass on a machine where someone had run
      // `npx playwright install` by hand — on a clean checkout it died with
      // "browserType.launch: Executable doesn't exist". It is downstream-only (added by
      // COD-261), so upstream CI never ran it and bitbucket ran nothing, which is exactly
      // the blind spot COD-293 exists to close. It still runs under the default
      // config/vitest.config.ts, like the other three.
      'test/file-preview-source-download.browser.test.ts', // browser (Playwright + chromium)
      'test/terminal-document-link.browser.test.ts', // browser/touch (Playwright + chromium)
      'test/terminal-copy-shortcut.test.ts', // browser (Playwright)
      'test/spreadsheet-preview.browser.test.ts', // browser (Playwright + chromium)
      'test/codex-predictive-echo.test.ts', // browser (Playwright) + real codex binary
      // Same omission as the COD-293 case above, recurring one commit later (COD-299).
      // Hand-maintained lists do not stay in sync with new files, so this is now
      // enforced by `npm run check:browser-excludes` rather than by remembering.
      'test/tab-rail-resize.browser.test.ts', // browser (Playwright + chromium)
      'test/tab-group-menu.browser.test.ts', // browser (Playwright + chromium)
      'test/tab-activation.browser.test.ts', // browser (Playwright + chromium)
      'test/tab-focus-smart-group.browser.test.ts', // browser (Playwright + chromium)
      'test/session-options-responsive.browser.test.ts', // browser (Playwright + chromium)
    ],
    setupFiles: ['./test/setup.ts'],
    fileParallelism: false,
    testTimeout: 30000,
    teardownTimeout: 60000,
  },
});
