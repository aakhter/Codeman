import { describe, expect, it } from 'vitest';

import { createRecoveryRecord, planAutomaticRecovery } from '../src/session-recovery.js';
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

  it('keeps remote reattachment distinct from Docker resume capability', () => {
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
    expect(createRecoveryRecord(session, { transport: 'docker' }).status).toBe('unavailable');
    expect(createRecoveryRecord({ ...session, nativeResumeId: 'rollout_123' }, { transport: 'docker' }).status).toBe(
      'resumable'
    );
  });

  it('records a selected remote Codex profile template for recovery instead of its start command', () => {
    const record = createRecoveryRecord({
      id: 'remote-template',
      pid: null,
      status: 'stopped',
      workingDir: '/workspace/project',
      currentTaskId: null,
      createdAt: 10,
      mode: 'codex',
      nativeResumeId: 'rollout_123',
      remote: {
        hostId: 'remote',
        label: 'Remote',
        host: 'remote.example',
        username: 'ubuntu',
        remotePath: '/workspace/project',
        commands: { codex: 'exec codex-router start' },
        codexCommandProfileId: 'profile-recoverable',
        codexResumeCommandTemplate: 'exec codex-router resume {{resumeId}}',
      },
    } as SessionState);

    expect(record).toMatchObject({
      transport: 'remote',
      status: 'reattachable',
      launch: { kind: 'template', templateId: 'profile-recoverable' },
    });
  });

  it.each([
    {
      remote: {
        hostId: 'remote',
        label: 'Remote',
        host: 'remote.example',
        username: 'ubuntu',
        remotePath: '/workspace/project',
        commands: { codex: 'exec codex-router start' },
      },
    },
    {
      docker: {
        hostId: 'docker',
        label: 'Docker',
        engine: 'docker',
        image: 'codeman-agent:latest',
        containerName: 'codeman-case-project',
        hostWorkspacePath: '/workspace/project',
        containerWorkdir: '/workspace/project',
        mountCredentials: false,
        hooksEnabled: false,
        resumeOnStart: true,
        commands: { codex: 'exec codex-router start' },
      },
    },
  ])('marks opaque custom Codex launchers manual_required in the durable recovery record', (transport) => {
    const record = createRecoveryRecord({
      id: 'custom-codex',
      pid: null,
      status: 'stopped',
      workingDir: '/workspace/project',
      currentTaskId: null,
      createdAt: 10,
      mode: 'codex',
      nativeResumeId: 'rollout_123',
      ...transport,
    } as SessionState);

    expect(record).toMatchObject({ status: 'manual_required', launch: { kind: 'manual_required' } });
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

describe('planAutomaticRecovery', () => {
  const local = createRecoveryRecord(
    {
      id: 'local',
      pid: null,
      status: 'stopped',
      workingDir: '/workspace/project',
      currentTaskId: null,
      createdAt: 10,
      mode: 'codex',
      nativeResumeId: '01a0c810-a5c4-7b32-be0b-1599d9d5995d',
    } as SessionState,
    { transport: 'local' }
  );

  it('resumes only a validated resumable local record', () => {
    expect(planAutomaticRecovery(local, false)).toBe('resume');
    expect(planAutomaticRecovery({ ...local, status: 'unavailable' }, false)).toBeNull();
  });

  it('reconnects a live owned remote even when its resume launcher is opaque', () => {
    expect(
      planAutomaticRecovery(
        {
          ...local,
          transport: 'remote',
          remote: { hostId: 'remote', owned: true },
          status: 'manual_required',
          launch: { kind: 'manual_required', hint: 'manual only' },
        },
        true
      )
    ).toBe('reconnect');
  });

  it('never auto-launches an opaque or ambiguous dead record', () => {
    expect(
      planAutomaticRecovery(
        {
          ...local,
          transport: 'remote',
          remote: { hostId: 'remote', owned: true },
          status: 'manual_required',
          launch: { kind: 'manual_required', hint: 'manual only' },
        },
        false
      )
    ).toBeNull();
  });
});
