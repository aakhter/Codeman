import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { enrichRecoveryNames, readClaudeRecoveryDetails } from '../src/session-recovery-names.js';
import type { SessionRecoveryRecord } from '../src/types/session-recovery.js';

const thread = '01a0c810-a5c4-7b32-be0b-1599d9d5995d';
const record: SessionRecoveryRecord = {
  id: 'recovery-pane',
  sourceSessionId: 'pane',
  mode: 'codex',
  workingDir: '/work/project',
  transport: 'local',
  status: 'unavailable',
  launch: { kind: 'built-in' },
  createdAt: 1,
};
let root: string;
let oldEnv: Record<string, string | undefined>;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'recovery-names-'));
  oldEnv = { CODEX_HOME: process.env.CODEX_HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
  process.env.CODEX_HOME = join(root, 'codex');
  process.env.CLAUDE_CONFIG_DIR = join(root, 'claude');
});
afterEach(() => {
  for (const [key, value] of Object.entries(oldEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

describe('recovery display names', () => {
  it('finds the exact native title and last recorded Codeman tab name without changing recovery status', async () => {
    const dir = join(process.env.CODEX_HOME!, 'sessions', '2026', '10', '03');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'rollout-names.jsonl'),
      JSON.stringify({
        type: 'session_meta',
        payload: {
          id: thread,
          cwd: '/work/project',
          originator: 'codeman_pane',
          source: 'cli',
        },
      }) + '\n'
    );
    writeFileSync(
      join(process.env.CODEX_HOME!, 'session_index.jsonl'),
      JSON.stringify({ id: thread, thread_name: 'Native conversation title' }) + '\n'
    );
    writeFileSync(
      join(root, 'session-lifecycle.jsonl'),
      [
        JSON.stringify({ sessionId: 'pane', name: 'w4-project', event: 'started' }),
        JSON.stringify({ sessionId: 'pane', name: 'auto:pane', event: 'recovered' }),
      ].join('\n')
    );
    const [view] = await enrichRecoveryNames([record], () => null, root);
    expect(view).toMatchObject({
      name: 'w4-project',
      nameFromLifecycle: true,
      conversationName: 'Native conversation title',
      status: 'unavailable',
    });
    expect(record).not.toHaveProperty('name');
    expect(view.nativeResumeId).toBeUndefined();
  });

  it('prefers a persisted tab name over older lifecycle names', async () => {
    writeFileSync(join(root, 'session-lifecycle.jsonl'), JSON.stringify({ sessionId: 'pane', name: 'old-tab' }));
    const [view] = await enrichRecoveryNames([{ ...record, name: 'new-tab' }], () => null, root);
    expect(view.name).toBe('new-tab');
    expect(view.nameFromLifecycle).toBeUndefined();
  });

  it('requires message identity and workspace evidence for Claude Refresh, not a title or filename', async () => {
    const dir = join(process.env.CLAUDE_CONFIG_DIR!, 'projects', '-work-project');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${thread}.jsonl`);
    const target = { ...record, mode: 'claude' as const, sourceSessionId: thread };
    writeFileSync(path, JSON.stringify({ type: 'ai-title', aiTitle: 'Title only' }) + '\n');
    expect((await readClaudeRecoveryDetails(target)).resumeId).toBeUndefined();
    writeFileSync(path, JSON.stringify({ type: 'user', sessionId: thread, cwd: '/other' }) + '\n');
    expect((await readClaudeRecoveryDetails(target)).resumeId).toBeUndefined();
    writeFileSync(path, JSON.stringify({ type: 'user', sessionId: thread, cwd: '/work/project' }) + '\n');
    expect((await readClaudeRecoveryDetails(target)).resumeId).toBe(thread);
  });

  it('reads an exact Claude conversation title and leaves an unknown name absent', async () => {
    const dir = join(process.env.CLAUDE_CONFIG_DIR!, 'projects', '-work-project');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${thread}.jsonl`),
      [
        JSON.stringify({ type: 'ai-title', aiTitle: 'AI session title' }),
        JSON.stringify({ type: 'custom-title', customTitle: 'Named Claude session' }),
      ].join('\n')
    );
    const views = await enrichRecoveryNames(
      [{ ...record, mode: 'claude', sourceSessionId: thread }, record],
      () => null,
      root
    );
    expect(views[0].conversationName).toBe('Named Claude session');
    expect(views[1].conversationName).toBeUndefined();
  });
});
