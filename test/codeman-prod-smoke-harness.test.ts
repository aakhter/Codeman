import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const smokeHarnessPath = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'codeman-prod-realistic-smoke-harness-contract.mjs'
);

type Contract = {
  activeTargets: string[];
  runTargets: string[];
  marks: string[];
  screenshotAttachments: Array<{
    sessionId: string;
    fileName: string;
    attachmentEndpoint: string;
  }>;
};

async function buildContract(targetArg = ''): Promise<Contract> {
  const module = (await import(pathToFileURL(smokeHarnessPath).href)) as {
    buildSmokeHarnessContract: (input?: string) => Contract;
  };
  return module.buildSmokeHarnessContract(targetArg);
}

describe('Codeman realistic smoke harness', () => {
  // This fixture is an in-repo deterministic contract for the external smoke
  // harness behavior. The canonical runner is not editable in-repo, so this test
  // validates the local contract shape explicitly.
  it('registers captured screenshots as Codeman attachments', async () => {
    const contract = await buildContract();

    expect(contract.screenshotAttachments.length).toBeGreaterThanOrEqual(3);
    expect(contract.screenshotAttachments.map((call) => call.attachmentEndpoint)).toContain(
      '/api/sessions/opencode-session/attachments'
    );
    expect(contract.screenshotAttachments.map((call) => call.attachmentEndpoint)).toContain(
      '/api/sessions/claude-session/attachments'
    );
    expect(contract.marks).toContain('screenshot attachment card visible');
    expect(contract.marks).toContain('stale Codex snapshot is replaced by full-history replay after reload');
  });

  it('supports single-target filtering via --target', async () => {
    const contract = await buildContract('--target opencode');

    expect(contract.activeTargets).toEqual(['opencode']);
    expect(contract.runTargets).toEqual(['opencode']);
    expect(contract.marks).toContain('OpenCode live mirror smoke session check');
    expect(contract.screenshotAttachments.some((it) => it.sessionId === 'opencode-session')).toBe(true);
    expect(contract.screenshotAttachments.some((it) => it.sessionId === 'claude-session')).toBe(false);
  });

  it('supports comma-separated target filtering', async () => {
    const contract = await buildContract('--targets claude,opencode');

    expect(contract.activeTargets).toEqual(['claude', 'opencode']);
    expect(contract.runTargets).toEqual(['claude', 'opencode']);
  });

  it('uses OpenCode-specific smoke naming for live mirror behavior', async () => {
    const contract = await buildContract();

    expect(contract.marks).toContain('OpenCode live mirror smoke session check');
    expect(contract.marks.some((mark) => /open.?code live mirror/i.test(mark))).toBe(true);
  });
});
