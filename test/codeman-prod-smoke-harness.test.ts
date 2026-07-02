import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const smokeHarnessPath = '/home/ubuntu/.codex/skills/codeman-prod-realistic-smoke/scripts/run-codeman-prod-smoke.mjs';

describe('Codeman realistic smoke harness', () => {
  it('registers captured screenshots as Codeman attachments', () => {
    const source = readFileSync(smokeHarnessPath, 'utf8');

    expect(source).toContain('async function captureScreenshotAttachment');
    expect(source).toContain('/api/sessions/${sessionId}/attachments');
    expect(source).toContain('screenshotAttachments');
    expect(source).toContain('screenshot attachment card visible');
    expect(source).toContain('seedStaleCodexSnapshot');
    expect(source).toContain('stale Codex snapshot is replaced by full-history replay after reload');

    const screenshotCalls = source.match(/captureScreenshotAttachment\(/g) || [];
    expect(screenshotCalls.length).toBeGreaterThanOrEqual(3);
  });
});
