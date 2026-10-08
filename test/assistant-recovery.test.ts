import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, mkdtempSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AssistantStore } from '../src/assistant-store.js';
import { AssistantRegistry } from '../src/assistant-registry.js';
import { AssistantRequestStore } from '../src/assistant-request-store.js';
import { AssistantRequestManager, type AssistantExecutionSession } from '../src/assistant-request-manager.js';
import { AssistantRecovery, assistantComposerEmpty, type AssistantRecoveryAdapter } from '../src/assistant-recovery.js';
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
      recovery: { state: 'armed', attempts: 1 },
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
