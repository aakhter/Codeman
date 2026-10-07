import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
it('runs the isolated OpenClaw transport and native-contract regression suites', () => {
  const result = execFileSync(process.execPath, ['--test', 'connector.test.mjs', 'codex-contract-spike.test.mjs'], {
    cwd: fileURLToPath(new URL('../integrations/openclaw/', import.meta.url)),
    encoding: 'utf8',
    timeout: 30000,
  });
  expect(result).toContain('fail 0');
});
