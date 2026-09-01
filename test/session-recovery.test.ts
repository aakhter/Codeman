import { describe, expect, it } from 'vitest';

import { createRecoveryRecord } from '../src/session-recovery.js';
import type { SessionState } from '../src/types/session.js';

describe('createRecoveryRecord', () => {
  it('creates a resumable local Codex record without private session data', () => {
    const record = createRecoveryRecord(
      {
        id: 'old-codex',
        pid: null,
        status: 'stopped',
        workingDir: '/workspace/project',
        currentTaskId: null,
        createdAt: 10,
        lastActivityAt: 20,
        mode: 'codex',
        owner: 'alice',
        nativeResumeId: 'rollout-123',
        codexConfig: { model: 'gpt-5.6', apiKey: 'OPENAI_API_KEY' } as never,
        __envOverrides: { OPENAI_API_KEY: 'secret' },
      } as SessionState,
      { transport: 'local' }
    );

    expect(record).toMatchObject({
      id: 'recovery-old-codex',
      sourceSessionId: 'old-codex',
      owner: 'alice',
      mode: 'codex',
      workingDir: '/workspace/project',
      transport: 'local',
      nativeResumeId: 'rollout-123',
      status: 'resumable',
      launch: { kind: 'built-in' },
      createdAt: 10,
      lastActivityAt: 20,
    });
    expect(JSON.stringify(record)).not.toContain('OPENAI_API_KEY');
    expect(JSON.stringify(record)).not.toContain('secret');
  });

  it('prefers reattachment for remote and Docker sessions', () => {
    const session = {
      id: 'remote-codex',
      pid: null,
      status: 'stopped',
      workingDir: '/workspace/project',
      currentTaskId: null,
      createdAt: 10,
      lastActivityAt: 20,
      mode: 'codex',
    } as SessionState;

    expect(createRecoveryRecord(session, { transport: 'remote' }).status).toBe('reattachable');
    expect(createRecoveryRecord(session, { transport: 'docker' }).status).toBe('reattachable');
  });

  it('retains the allowlisted Claude conversation ID when only resumeSessionId is available', () => {
    const record = createRecoveryRecord(
      {
        id: 'old-claude',
        pid: null,
        status: 'stopped',
        workingDir: '/workspace/project',
        currentTaskId: null,
        createdAt: 10,
        lastActivityAt: 20,
        mode: 'claude',
        resumeSessionId: 'claude-conversation-123',
      } as SessionState,
      { transport: 'local' }
    );

    expect(record).toMatchObject({
      status: 'resumable',
      claudeResumeId: 'claude-conversation-123',
    });
  });

  it('replaces arbitrary manual diagnostic hints with a fixed safe hint', () => {
    const rawHint = 'ssh: connect to host example.internal: Permission denied; password=super-secret';
    const record = createRecoveryRecord(
      {
        id: 'manual',
        pid: null,
        status: 'stopped',
        workingDir: '/workspace/project',
        currentTaskId: null,
        createdAt: 10,
        lastActivityAt: 20,
        mode: 'codex',
      } as SessionState,
      { transport: 'local', launch: { kind: 'manual_required', hint: rawHint } }
    );

    expect(record).toMatchObject({
      status: 'manual_required',
      launch: {
        kind: 'manual_required',
        hint: 'Manual recovery is required. Start a new session from the original working directory.',
      },
    });
    expect(JSON.stringify(record)).not.toContain(rawHint);
    expect(JSON.stringify(record)).not.toContain('super-secret');
  });
});
