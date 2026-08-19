import { resolve } from 'node:path';
import { defineConfig, configDefaults } from 'vitest/config';
import { NON_CI_TEST_GLOBS } from './test-suites';

const root = resolve(import.meta.dirname, '..');

/**
 * The default gate — what `npm test` and CI both run.
 *
 * Same as vitest.config.ts but EXCLUDES the suites that cannot pass on an
 * arbitrary machine: browser-driven (Playwright + chromium), visual-regression
 * (per-machine PNG baselines) and wall-clock perf. Those are not unmaintained;
 * they have their own runners (`test:browser`, `test:mobile`, `test:perf`).
 * See config/test-suites.ts for the list and the reason behind each entry.
 *
 * Keep the rest in sync with config/vitest.config.ts.
 */
export default defineConfig({
  // Vite externalizes `node:` builtins for any test declaring a non-node
  // environment, which breaks the readFileSync-based frontend tests that build
  // their own JSDOM window (they fail with "No such built-in module: node:").
  // Marking them external here keeps those files runnable under both configs.
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
    exclude: [...configDefaults.exclude, ...NON_CI_TEST_GLOBS],
    setupFiles: ['./test/setup.ts'],
    fileParallelism: false,
    testTimeout: 30000,
    teardownTimeout: 60000,
  },
});
