import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import {
  findActiveCodexConversation,
  findAuthoritativeCodexConversation,
  findCodexConversationId,
  findRecentOwnedCodexConversationIds,
  getCodexConversationIdentityDebugStats,
  resetCodexConversationIdentityDebugStats,
} from '../src/checkpoint-conversation-identity.js';

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

  it('invalidates a viewer history pin when history changes without another submit', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codeman-codex-history-refresh-'));
    const sessionsDir = join(codexHome, 'sessions');
    await mkdir(sessionsDir, { recursive: true });
    const first = '66666666-6666-4666-8666-666666666666';
    const second = '77777777-7777-4777-8777-777777777777';
    await writeFile(join(sessionsDir, `rollout-${first}.jsonl`), `${JSON.stringify({ type: 'session_meta' })}\n`);
    await writeFile(join(sessionsDir, `rollout-${second}.jsonl`), `${JSON.stringify({ type: 'session_meta' })}\n`);
    const historyPath = join(codexHome, 'history.jsonl');
    await writeFile(historyPath, `${JSON.stringify({ session_id: first, ts: 10 })}\n`);
    const options = { codexHome, sessionId: 'pane-a', lastSubmitAt: 10_000 };
    await expect(findActiveCodexConversation(options)).resolves.toMatchObject({ id: first });

    await writeFile(historyPath, `${JSON.stringify({ session_id: second, ts: 10, changed: true })}\n`);
    await expect(findActiveCodexConversation(options)).resolves.toMatchObject({ id: second });
  });

  it('rescans when a first history pin references a rollout missing from cached inventory', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codeman-codex-first-history-pin-'));
    const sessionsDir = join(codexHome, 'sessions');
    await mkdir(sessionsDir, { recursive: true });
    const old = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const fresh = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    await writeFile(
      join(sessionsDir, `rollout-${old}.jsonl`),
      `${JSON.stringify({ type: 'session_meta', payload: { originator: 'codeman_pane-a' } })}\n`
    );
    await expect(findActiveCodexConversation({ codexHome, sessionId: 'pane-a' })).resolves.toMatchObject({ id: old });

    await writeFile(join(sessionsDir, `rollout-${fresh}.jsonl`), `${JSON.stringify({ type: 'session_meta' })}\n`);
    await writeFile(join(codexHome, 'history.jsonl'), `${JSON.stringify({ session_id: fresh, ts: 10 })}\n`);
    await expect(
      findActiveCodexConversation({ codexHome, sessionId: 'pane-a', lastSubmitAt: 10_000 })
    ).resolves.toMatchObject({ id: fresh });
  });

  it('bounds rescans when a history target remains missing', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codeman-codex-missing-history-target-'));
    await mkdir(join(codexHome, 'sessions'), { recursive: true });
    const missing = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    await writeFile(join(codexHome, 'history.jsonl'), `${JSON.stringify({ session_id: missing, ts: 10 })}\n`);
    resetCodexConversationIdentityDebugStats();
    const options = { codexHome, sessionId: 'pane-a', lastSubmitAt: 10_000 };

    await findActiveCodexConversation(options);
    await findActiveCodexConversation(options);
    await findActiveCodexConversation(options);

    expect(getCodexConversationIdentityDebugStats().rolloutTreeWalkCount).toBe(2);
  });

  it('caches unchanged rollout inventories and detects an invalidated new owned rollout', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codeman-codex-inventory-'));
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-08-02T12:00:00Z'));
    const sessionsDir = join(codexHome, 'sessions', '2026', '08', '02');
    await mkdir(sessionsDir, { recursive: true });
    const baseline = '88888888-8888-4888-8888-888888888888';
    const historical = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const fresh = '99999999-9999-4999-8999-999999999999';
    const meta = (id: string) =>
      writeFile(
        join(sessionsDir, `rollout-${id}.jsonl`),
        `${JSON.stringify({ type: 'session_meta', payload: { originator: 'codeman_pane-a' } })}\n`
      );
    await meta(historical);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await meta(baseline);
    resetCodexConversationIdentityDebugStats();

    await findCodexConversationId({ codexHome, sessionId: 'pane-a' });
    vi.setSystemTime(new Date('2026-08-02T12:00:00.600Z'));
    await findCodexConversationId({ codexHome, sessionId: 'pane-a' });
    vi.setSystemTime(new Date('2026-08-02T12:00:01.200Z'));
    await findCodexConversationId({ codexHome, sessionId: 'pane-a' });
    expect(getCodexConversationIdentityDebugStats().rolloutTreeWalkCount).toBe(1);

    const baselineIds = await findRecentOwnedCodexConversationIds({ codexHome, sessionId: 'pane-a' });

    await expect(
      findAuthoritativeCodexConversation({ codexHome, sessionId: 'pane-a', baselineId: baseline, baselineIds })
    ).resolves.toBeUndefined();

    vi.setSystemTime(new Date('2026-08-02T12:00:01.800Z'));
    await meta(fresh);
    await expect(
      findAuthoritativeCodexConversation({ codexHome, sessionId: 'pane-a', baselineId: baseline, baselineIds })
    ).resolves.toMatchObject({ id: fresh });
    expect(getCodexConversationIdentityDebugStats()).toMatchObject({
      rolloutTreeWalkCount: 1,
      authoritativeDirectoryScanCount: 3,
    });
    vi.useRealTimers();
  });
});
