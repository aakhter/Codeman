import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

const root = resolve(import.meta.dirname, '..');

/**
 * EVERY test in the repo, including the ones that cannot pass on an arbitrary
 * machine — `npm run test:all`. Reach for it when you want the complete picture
 * and are prepared to read past environmental failures.
 *
 * This is NOT what `npm test` runs. On a machine without chromium, a free port
 * or per-machine PNG baselines this config fails ~87 tests on a clean master,
 * which makes it useless as a pass/fail signal: the default gate is
 * config/vitest.ci.config.ts, and the suites it leaves out each have their own
 * runner (`test:browser`, `test:perf`, `test:mobile`). See config/test-suites.ts.
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
