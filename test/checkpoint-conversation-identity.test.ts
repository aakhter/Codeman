import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { findActiveCodexConversation, findCodexConversationId } from '../src/checkpoint-conversation-identity.js';

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

  it('prefers actual TUI history selection over newer originator and configured resume rollouts', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codeman-codex-history-'));
    const sessionsDir = join(codexHome, 'sessions');
    await mkdir(sessionsDir, { recursive: true });
    const actual = '33333333-3333-4333-8333-333333333333';
    const originator = '44444444-4444-4444-8444-444444444444';
    const resume = '55555555-5555-4555-8555-555555555555';
    await writeFile(join(sessionsDir, `rollout-${actual}.jsonl`), `${JSON.stringify({ type: 'session_meta' })}\n`);
    await writeFile(
      join(sessionsDir, `rollout-${originator}.jsonl`),
      `${JSON.stringify({ type: 'session_meta', payload: { originator: 'codeman_pane-a' } })}\n`
    );
    await writeFile(join(sessionsDir, `rollout-${resume}.jsonl`), `${JSON.stringify({ type: 'session_meta' })}\n`);
    await writeFile(join(codexHome, 'history.jsonl'), `${JSON.stringify({ session_id: actual, ts: 10 })}\n`);

    await expect(
      findActiveCodexConversation({
        codexHome,
        sessionId: 'pane-a',
        workingDir: '/work/project',
        resumeSessionId: resume,
        lastSubmitAt: 10_000,
        competingSubmitAts: [],
      })
    ).resolves.toMatchObject({ id: actual });
  });
});
