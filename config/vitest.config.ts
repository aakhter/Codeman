import { resolve } from 'node:path';
import { configDefaults, defineConfig } from 'vitest/config';
import { chromiumInstalled } from '../test/mobile/helpers/browser-available.js';

const root = resolve(import.meta.dirname, '..');

// COD-99: a fresh worktree has the `playwright` package but no browser binary, so the
// `test/mobile/**` suite (real Chromium via helpers/browser.ts) errors ~280× on a bare
// `npm test`. When the binary is absent, exclude that suite with a clear message instead —
// the same thing CI (`vitest.ci.config.ts`) already does — so a browser-less run is clean.
// Install the browser (`npx playwright install chromium`) to run the mobile suite.
const skipMobile = !chromiumInstalled();
if (skipMobile) {
  console.warn(
    '[vitest] Playwright Chromium not installed — excluding test/mobile/** (browser suite). ' +
      'Run `npx playwright install chromium` to enable the mobile tests.'
  );
}

export default defineConfig({
  test: {
    root,
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    exclude: [...configDefaults.exclude, ...(skipMobile ? ['test/mobile/**'] : [])],
    setupFiles: ['./test/setup.ts'],
    // Run test files sequentially to respect mux session limits
    // Individual tests within files still run in parallel where safe
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts', 'src/cli.ts'],
    },
    testTimeout: 30000, // 30 seconds for integration tests
    // Ensure cleanup runs even on test failures
    teardownTimeout: 60000,
  },
});
