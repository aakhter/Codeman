import { mkdtemp, mkdir, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { findClaudeConversationId, findCodexConversationId } from '../src/checkpoint-conversation-identity.js';

describe('checkpoint conversation identity', () => {
  it('selects the rollout bound to this Codeman pane rather than another pane newest file', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codeman-codex-identity-'));
    const sessionsDir = join(codexHome, 'sessions', '2026', '08', '02');
    await mkdir(sessionsDir, { recursive: true });
    const ownId = '11111111-1111-4111-8111-111111111111';
    const wrongId = '22222222-2222-4222-8222-222222222222';
    await writeFile(
      join(sessionsDir, `rollout-2026-08-02T00-00-00-${ownId}.jsonl`),
      `${JSON.stringify({ type: 'session_meta', payload: { originator: 'codeman_pane-a' } })}\n`
    );
    await writeFile(
      join(sessionsDir, `rollout-2026-08-02T00-00-01-${wrongId}.jsonl`),
      `${JSON.stringify({ type: 'session_meta', payload: { originator: 'codeman_pane-b' } })}\n`
    );

    await expect(findCodexConversationId({ codexHome, sessionId: 'pane-a' })).resolves.toBe(ownId);
  });

  it('fails closed when no rollout is bound to this pane', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codeman-codex-identity-'));
    await expect(findCodexConversationId({ codexHome, sessionId: 'missing' })).resolves.toBeUndefined();
  });

  it('binds a new Claude transcript to this transition instead of another pane transition', async () => {
    const claudeHome = await mkdtemp(join(tmpdir(), 'codeman-claude-identity-'));
    const projectDir = join(claudeHome, 'projects', 'fixture');
    await mkdir(projectDir, { recursive: true });
    const ours = join(projectDir, '33333333-3333-4333-8333-333333333333.jsonl');
    const wrong = join(projectDir, '44444444-4444-4444-8444-444444444444.jsonl');
    await writeFile(ours, `${JSON.stringify({ cwd: '/work/project' })}\n`);
    await writeFile(wrong, `${JSON.stringify({ cwd: '/work/project' })}\n`);
    await utimes(ours, new Date(10_100), new Date(10_100));
    await utimes(wrong, new Date(10_900), new Date(10_900));

    await expect(
      findClaudeConversationId({
        claudeHome,
        workingDir: '/work/project',
        baselineId: 'old-id',
        transitionAt: 10_000,
        competingTransitionAts: [10_850],
      })
    ).resolves.toBe('33333333-3333-4333-8333-333333333333');
  });
});
