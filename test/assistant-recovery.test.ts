import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, mkdtempSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AssistantStore } from '../src/assistant-store.js';
import { AssistantRegistry } from '../src/assistant-registry.js';
import { AssistantRequestStore } from '../src/assistant-request-store.js';
import { AssistantRequestManager, type AssistantExecutionSession } from '../src/assistant-request-manager.js';
import {
  AssistantRecovery,
  assistantComposerEmpty,
  assistantCodexRecoveryProfile,
  assistantRecoveryGroup,
  type AssistantRecoveryAdapter,
} from '../src/assistant-recovery.js';
import type { AssistantDefinition } from '../src/types/assistant.js';

let root: string, home: string, file: string, conversation: string;
let store: AssistantStore, ledger: AssistantRequestStore, manager: AssistantRequestManager, recovery: AssistantRecovery;
let a: AssistantDefinition, original: AssistantExecutionSession, sessions: Map<string, AssistantExecutionSession>;
let adapter: AssistantRecoveryAdapter, writes: string[];
function session(id: string, pid: number): AssistantExecutionSession {
  return {
    id,
    pid,
    status: 'idle',
    mode: 'codex',
    workingDir: root,
    nativeResumeId: conversation,
    codexConfig: { resumeSessionId: conversation },
    assistantPendingWrites: 0,
    assistantLastInputAt: 0,
    isCheckpointActive: false,
    getCodexHomeOverride: () => home,
    hasLostCodexProviderCredentials: () => false,
    setAssistantInputGuard: () => {},
    cancelAssistantSubmitVerification: () => {},
    writeViaMux: async (text) => {
      writes.push(text);
      return true;
    },
  };
}
function coordinator(): AssistantRecovery {
  const r = new AssistantRecovery(store, manager, (id) => sessions.get(id), adapter, join(root, 'recovery.json'), 0);
  manager.setRecovery(r);
  return r;
}
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'assistant-recovery-'));
  home = join(root, 'codex');
  conversation = randomUUID();
  mkdirSync(join(home, 'sessions'), { recursive: true });
  file = join(home, 'sessions', `rollout-${conversation}.jsonl`);
  writeFileSync(
    file,
    JSON.stringify({ type: 'session_meta', payload: { id: conversation, cwd: root, originator: 'codeman_original' } }) +
      '\n'
  );
  store = new AssistantStore(join(root, 'assistants.json'));
  ledger = new AssistantRequestStore(join(root, 'requests.json'));
  original = session('original', 100);
  sessions = new Map([[original.id, original]]);
  writes = [];
  manager = new AssistantRequestManager(store, ledger, (id) => sessions.get(id));
  adapter = {
    snapshot: () => ({ name: 'w1-brain', codexConfig: { model: 'test-model' } }),
    create: vi.fn(async (id) => {
      const s = session(id, 200);
      sessions.set(id, s);
      return s;
    }),
    composerEmpty: async () => true,
    ownerAllowed: async () => true,
  };
  recovery = coordinator();
  const registry = new AssistantRegistry(store);
  const created = registry.create(undefined, 'Brain', 'brain');
  const bound = await registry.bind(created, 1, 0, original);
  a = registry.update(bound, 2, { enabled: true });
  await manager.handoff(a, a.revision, true);
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});
describe('exact assistant session recovery', () => {
  it('recreates a deleted idle session, preserves native identity and token grants, restores handoff', async () => {
    const issued = store.issueToken(a, 'connector', ['read', 'submit', 'cancel']);
    sessions.delete(original.id);
    await manager.tick();
    const next = store.get(a.id)!;
    expect(next.binding).toMatchObject({
      conversationId: conversation,
      codexHome: home,
      workingDir: root,
      generation: 2,
    });
    expect(next.binding!.sessionId).not.toBe(original.id);
    expect(manager.availability(next)).toMatchObject({
      requestExecution: true,
      inputLocked: true,
      recovery: { state: 'armed', attempts: 0 },
    });
    expect(store.authenticate(issued.token)).toBeDefined();
    expect(writes).toEqual([]);
  });
  it('recovers an exited agent even when the tmux PTY PID still exists', async () => {
    original.paneExit = { at: Date.now() };
    await manager.tick();
    expect(adapter.create).toHaveBeenCalledTimes(1);
    expect(manager.availability(store.get(a.id)!).requestExecution).toBe(true);
  });
  it('persists group moves before deletion and retains them across recovery restart', async () => {
    adapter.placement = () => 'group-cisco';
    recovery.capturePlacement(original.id);
    recovery = coordinator();
    sessions.delete(original.id);
    await manager.tick();
    expect(adapter.create).toHaveBeenCalledWith(
      expect.any(String),
      expect.anything(),
      expect.objectContaining({ tabGroupId: 'group-cisco' })
    );
    expect(manager.availability(store.get(a.id)!).requestExecution).toBe(true);
  });
  it('records explicit ungrouped placement instead of keeping a previous group', async () => {
    adapter.placement = () => 'old-group';
    recovery.capturePlacement(original.id);
    adapter.placement = () => null;
    recovery.capturePlacement(original.id);
    sessions.delete(original.id);
    await manager.tick();
    expect(adapter.create).toHaveBeenCalledWith(
      expect.any(String),
      expect.anything(),
      expect.objectContaining({ tabGroupId: null })
    );
  });
  it('retries only a natively proven dead startup candidate, even when its PTY PID remains', async () => {
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    let launches = 0;
    adapter.create = vi.fn(async (id) => {
      const candidate = session(id, 200);
      if (++launches === 1) candidate.status = 'busy';
      sessions.set(id, candidate);
      return candidate;
    });
    adapter.candidateExited = async (candidate) => candidate.status === 'busy';
    sessions.delete(original.id);
    await manager.tick();
    expect(recovery.status(a.id)).toMatchObject({ state: 'armed', attempts: 1 });
    now += 31000;
    await manager.tick();
    expect(adapter.create).toHaveBeenCalledTimes(2);
    expect(manager.availability(store.get(a.id)!).requestExecution).toBe(true);
    expect(writes).toEqual([]);
  });
  it('keeps a potentially live failed candidate blocked when exit cannot be proven', async () => {
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    adapter.create = vi.fn(async (id) => {
      const candidate = session(id, 200);
      candidate.status = 'busy';
      sessions.set(id, candidate);
      return candidate;
    });
    adapter.candidateExited = async () => false;
    sessions.delete(original.id);
    await manager.tick();
    now += 61000;
    await manager.tick();
    expect(recovery.status(a.id)).toMatchObject({ state: 'blocked', attempts: 1 });
    expect(adapter.create).toHaveBeenCalledTimes(1);
  });
  it('moves only unsent queued requests to the recovered binding and submits once', async () => {
    const request = manager.submit(a, 'queued prompt', 'queued-key-123456789');
    sessions.delete(original.id);
    await manager.tick();
    expect(ledger.get(request.id)).toMatchObject({ status: 'dispatching', binding: { generation: 2 } });
    expect(writes).toEqual(['queued prompt\r']);
    expect(manager.submit(store.get(a.id)!, 'queued prompt', 'queued-key-123456789').id).toBe(request.id);
  });
  it('does not replay or rebind work whose submission may already have occurred', async () => {
    const request = manager.submit(a, 'running prompt', 'running-key-123456789');
    await manager.tick();
    sessions.delete(original.id);
    await manager.tick();
    expect(ledger.get(request.id)?.status).toBe('outcome_unknown');
    expect(adapter.create).not.toHaveBeenCalled();
    expect(recovery.status(a.id)?.state).toBe('blocked');
    expect(writes).toHaveLength(1);
  });
  it('fails closed if the original conversation is missing or unfinished', async () => {
    sessions.delete(original.id);
    unlinkSync(file);
    await manager.tick();
    expect(adapter.create).not.toHaveBeenCalled();
    expect(recovery.status(a.id)?.state).toBe('blocked');
  });
  it('does not resume a transcript with an unfinished native turn', async () => {
    appendFileSync(
      file,
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: randomUUID() } }) + '\n'
    );
    sessions.delete(original.id);
    await manager.tick();
    expect(adapter.create).not.toHaveBeenCalled();
    expect(recovery.status(a.id)?.state).toBe('blocked');
  });
  it('refuses partial or malformed transcript tails before launching', async () => {
    appendFileSync(file, '{"type":"event_msg"');
    sessions.delete(original.id);
    await manager.tick();
    expect(adapter.create).not.toHaveBeenCalled();
    expect(recovery.status(a.id)?.state).toBe('blocked');
  });
  it('will not reconnect to a different conversation', async () => {
    adapter.create = vi.fn(async (id) => {
      const s = session(id, 200);
      s.nativeResumeId = randomUUID();
      sessions.set(id, s);
      return s;
    });
    sessions.delete(original.id);
    await manager.tick();
    expect(manager.availability(store.get(a.id)!).requestExecution).toBe(false);
    expect(store.get(a.id)!.binding!.conversationId).toBe(conversation);
    // Identity resolution failure leaves a live candidate locked for explicit desktop recovery.
    expect(recovery.status(a.id)?.state).toBe('blocked');
  });
  it('checks current owner authorization before spawning', async () => {
    adapter.ownerAllowed = async () => false;
    sessions.delete(original.id);
    await manager.tick();
    expect(adapter.create).not.toHaveBeenCalled();
    expect(recovery.status(a.id)?.state).toBe('blocked');
  });
  it('resets the failure budget after every successful restart recovery', async () => {
    for (let i = 0; i < 5; i++) {
      const current = store.get(a.id)!;
      const live = sessions.get(current.binding!.sessionId)!;
      // A web restart changes the attaching PTY PID while native identity survives.
      live.pid! += 1;
      recovery = coordinator();
      await manager.tick();
      expect(recovery.status(a.id)).toMatchObject({ state: 'armed', attempts: 0 });
      expect(manager.availability(store.get(a.id)!).requestExecution).toBe(true);
    }
    expect(adapter.create).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });

  it('limits failed recovery across coordinator restarts to three attempts', async () => {
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    adapter.create = vi.fn(async () => {
      throw new Error('launch failed');
    });
    sessions.delete(original.id);
    for (let i = 0; i < 4; i++) {
      now += 31000;
      recovery = coordinator();
      await manager.tick();
    }
    expect(adapter.create).toHaveBeenCalledTimes(3);
    expect(recovery.status(a.id)).toMatchObject({ state: 'blocked', attempts: 3 });
  });
  it('does not spawn a duplicate candidate after restarting during startup', async () => {
    adapter.create = vi.fn(async (id) => {
      const s = session(id, 200);
      s.status = 'working';
      sessions.set(id, s);
      return s;
    });
    sessions.delete(original.id);
    await manager.tick();
    recovery = coordinator();
    await manager.tick();
    expect(adapter.create).toHaveBeenCalledTimes(1);
    const candidate = [...sessions.values()][0];
    candidate.status = 'idle';
    await manager.tick();
    expect(manager.availability(store.get(a.id)!).requestExecution).toBe(true);
  });
  it('Take control cancels recovery even if session creation is in flight', async () => {
    let release: () => void = () => {};
    const wait = new Promise<void>((r) => {
      release = r;
    });
    adapter.create = vi.fn(async (id) => {
      await wait;
      const s = session(id, 200);
      sessions.set(id, s);
      return s;
    });
    sessions.delete(original.id);
    const tick = manager.tick();
    await vi.waitFor(() => expect(adapter.create).toHaveBeenCalledTimes(1));
    await manager.takeControl(a);
    release();
    await tick;
    expect(store.get(a.id)!.enabled).toBe(false);
    expect(recovery.status(a.id)).toBeUndefined();
    expect(store.get(a.id)!.binding!.sessionId).toBe(original.id);
  });
  it('does not recover an assistant after desktop takes control', async () => {
    await manager.takeControl(a);
    sessions.delete(original.id);
    await manager.tick();
    expect(adapter.create).not.toHaveBeenCalled();
  });
});
describe('empty composer proof', () => {
  it('allows empty composer and dim placeholders but refuses text or unknown screens', () => {
    expect(assistantComposerEmpty('› ')).toBe(true);
    expect(assistantComposerEmpty('› \x1b[2mAsk Codex anything\x1b[0m')).toBe(true);
    expect(assistantComposerEmpty('› run this')).toBe(false);
    expect(assistantComposerEmpty('loading')).toBe(false);
    expect(assistantComposerEmpty('❯ ', 'claude')).toBe(true);
    expect(assistantComposerEmpty('❯ typed input', 'claude')).toBe(false);
    const box = (input: string) =>
      `history Ask anything…\n  ┃\n  ┃ ${input}\n  ┃\n  ┃ Plan · GPT-5.6 Sol OpenAI\n  ╹▀▀▀▀▀▀▀▀▀▀\n ctrl+p commands`;
    expect(assistantComposerEmpty(box(''), 'opencode')).toBe(true);
    expect(assistantComposerEmpty(box('Ask anything… "Try a question"'), 'opencode')).toBe(true);
    expect(assistantComposerEmpty(box('typed input'), 'opencode')).toBe(false);
    expect(assistantComposerEmpty('history Ask anything…', 'opencode')).toBe(false);
  });
});

describe('assistant recovery profiles', () => {
  it('resolves owner-provided raw and already-resumed launchers through a declared template', () => {
    const profiles = [
      {
        id: 'cisco',
        name: 'Cisco',
        command: 'exec codx cisco',
        resumeCommandTemplate: 'exec codx cisco resume {{resumeId}}',
      },
    ];
    for (const baseCommand of ['exec codx cisco', `exec codx cisco resume ${conversation}`])
      expect(assistantCodexRecoveryProfile({ baseCommand }, profiles, conversation).resumeCommandTemplate).toBe(
        profiles[0].resumeCommandTemplate
      );
  });
  it('rejects missing, invalid, conflicting, or foreign-owner templates', () => {
    const p = { id: 'cisco', name: 'Cisco', command: 'exec codx cisco' };
    for (const profiles of [
      [],
      [p],
      [{ ...p, resumeCommandTemplate: 'exec codx cisco' }],
      [
        { ...p, resumeCommandTemplate: 'exec codx cisco resume {{resumeId}}' },
        { ...p, id: 'other', resumeCommandTemplate: 'exec other resume {{resumeId}}' },
      ],
    ])
      expect(() => assistantCodexRecoveryProfile({ baseCommand: p.command }, profiles, conversation)).toThrow();
  });
  it('selects placement from the supplied owner layout only', () => {
    const layout = {
      version: 1,
      updatedAt: 'now',
      groups: [{ id: 'group', name: 'Cisco', refs: [{ kind: 'session' as const, id: 'original' }] }],
      ungrouped: [{ kind: 'session' as const, id: 'other' }],
    };
    expect(assistantRecoveryGroup(layout, 'original')).toBe('group');
    expect(assistantRecoveryGroup(layout, 'other')).toBeNull();
    expect(assistantRecoveryGroup(layout, 'foreign')).toBeUndefined();
    expect(assistantRecoveryGroup(null, 'original')).toBeUndefined();
  });
});
