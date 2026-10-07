import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  appendFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  renameSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { AssistantStore } from '../src/assistant-store.js';
import { AssistantRegistry } from '../src/assistant-registry.js';
import { AssistantRequestStore } from '../src/assistant-request-store.js';
import { AssistantRequestManager, type AssistantExecutionSession } from '../src/assistant-request-manager.js';
import { observeAssistantTurn } from '../src/assistant-turn-observer.js';
import { registerAuthMiddleware } from '../src/web/middleware/auth.js';
import { registerAssistantRoutes } from '../src/web/routes/assistant-routes.js';
import { installRouteErrorHandler } from '../src/web/route-error-handler.js';
import { Session } from '../src/session.js';

let root: string;
let assistants: AssistantStore;
let ledger: AssistantRequestStore;
let manager: AssistantRequestManager;
let live: AssistantExecutionSession;
let registry: AssistantRegistry;
let file: string;
let conversationId: string;
let allowed: (permit?: string) => boolean;
let writes: string[];
let validGrant: boolean;
let automation: boolean;
const row = (payload: object) => JSON.stringify({ type: 'event_msg', payload }) + '\n';
function turn(text: string, answer = 'result', id = randomUUID(), phase = 'final_answer'): string {
  return (
    row({ type: 'task_started', turn_id: id }) +
    row({
      type: 'item_completed',
      thread_id: conversationId,
      turn_id: id,
      item: { type: 'UserMessage', content: [{ type: 'text', text }] },
    }) +
    row({
      type: 'item_completed',
      thread_id: conversationId,
      turn_id: id,
      item: { type: 'AgentMessage', phase, content: [{ type: 'Text', text: answer }] },
    }) +
    row({ type: 'task_complete', turn_id: id, last_agent_message: answer })
  );
}
async function ready() {
  const a = registry.create(undefined, 'Brain', 'brain');
  const bound = await registry.bind(a, 1, 0, live);
  const enabled = registry.update(bound, 2, { enabled: true });
  await manager.handoff(enabled, 3, true);
  return assistants.get(a.id)!;
}
function restart() {
  manager = new AssistantRequestManager(
    assistants,
    new AssistantRequestStore(join(root, 'requests.json')),
    () => live,
    () => automation,
    async () => validGrant
  );
  manager.attach(live);
  return manager;
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'assistant-requests-'));
  assistants = new AssistantStore(join(root, 'assistants.json'));
  ledger = new AssistantRequestStore(join(root, 'requests.json'));
  conversationId = randomUUID();
  const home = join(root, 'codex');
  mkdirSync(join(home, 'sessions'), { recursive: true });
  file = join(home, 'sessions', `rollout-${conversationId}.jsonl`);
  writeFileSync(
    file,
    JSON.stringify({
      type: 'session_meta',
      payload: { id: conversationId, cwd: root, originator: 'codeman_test-pane', cli_version: '0.160.1' },
    }) + '\n'
  );
  writes = [];
  validGrant = true;
  automation = false;
  allowed = () => true;
  live = {
    id: 'test-pane',
    workingDir: root,
    mode: 'codex',
    pid: 123,
    status: 'idle',
    assistantPendingWrites: 0,
    assistantLastInputAt: 0,
    isCheckpointActive: false,
    getCodexHomeOverride: () => home,
    hasLostCodexProviderCredentials: () => false,
    setAssistantInputGuard: (guard) => {
      allowed = guard;
    },
    cancelAssistantSubmitVerification: () => {},
    writeViaMux: async (data, options) => {
      if (!allowed(options.assistantPermit)) return false;
      writes.push(data);
      return true;
    },
  };
  manager = new AssistantRequestManager(
    assistants,
    ledger,
    () => live,
    () => automation,
    async () => validGrant
  );
  manager.attach(live);
  registry = new AssistantRegistry(assistants, (id) => manager.outstanding(id));
});
afterEach(async () => {
  await manager.stop();
  rmSync(root, { recursive: true, force: true });
});
describe('durable assistant requests', () => {
  it('deduplicates across restart, conflicts on changed payload, and never replays completed work', async () => {
    const a = await ready();
    const r = manager.submit(a, 'hello', 'same-key-123456789');
    expect(manager.submit(a, 'hello', 'same-key-123456789').id).toBe(r.id);
    expect(() => manager.submit(a, 'different', 'same-key-123456789')).toThrow(/different payload/);
    await manager.tick();
    expect(writes).toEqual(['hello\r']);
    appendFileSync(file, turn('hello', 'matched answer'));
    restart();
    await manager.tick();
    expect(manager.store.get(r.id)?.result?.text).toBe('matched answer');
    expect(manager.submit(a, 'hello', 'same-key-123456789').id).toBe(r.id);
    await manager.tick();
    expect(writes).toHaveLength(1);
  });
  it('queues serially and only dispatches the next prompt after native completion', async () => {
    const a = await ready();
    const first = manager.submit(a, 'first', 'first-key-123456789');
    const second = manager.submit(a, 'second', 'second-key-123456789');
    await Promise.all([manager.tick(), manager.tick()]);
    expect(writes).toEqual(['first\r']);
    appendFileSync(file, turn('first'));
    await manager.tick();
    expect(manager.store.get(first.id)?.status).toBe('completed');
    expect(writes).toEqual(['first\r', 'second\r']);
    expect(manager.store.get(second.id)?.status).toBe('dispatching');
  });
  it('persists dispatch intent before delivery and holds ambiguous failures without automatic retry', async () => {
    const a = await ready();
    const r = manager.submit(a, 'hello', 'failure-key-123456789');
    live.writeViaMux = async () => {
      expect(new AssistantRequestStore(join(root, 'requests.json')).get(r.id)?.status).toBe('dispatching');
      throw new Error('lost write');
    };
    await manager.tick();
    expect(manager.store.get(r.id)?.status).toBe('outcome_unknown');
    expect(allowed()).toBe(false);
    const attempt = vi.spyOn(live, 'writeViaMux');
    restart();
    await manager.tick();
    expect(attempt).not.toHaveBeenCalled();
    await manager.takeControl(a);
    expect(allowed()).toBe(true);
    const interrupted = manager.store.get(r.id)!;
    expect(() => manager.reconcile(interrupted, false)).toThrow(/acknowledge/);
    manager.reconcile(interrupted, true);
    expect(manager.outstanding(a.id)).toBe(false);
  });
  it('reconciles an accepted turn after restart without another PTY write', async () => {
    const a = await ready();
    const r = manager.submit(a, 'hello', 'restart-key-123456789');
    await manager.tick();
    const data = turn('hello');
    appendFileSync(file, data.slice(0, data.lastIndexOf('\n', data.length - 2) + 1));
    restart();
    await manager.tick();
    expect(manager.store.get(r.id)?.status).toBe('running');
    appendFileSync(file, data.slice(data.lastIndexOf('\n', data.length - 2) + 1));
    await manager.tick();
    expect(manager.store.get(r.id)?.status).toBe('completed');
    expect(writes).toHaveLength(1);
  });
  it('rejects desktop/conversation interference and truncation', async () => {
    const a = await ready();
    const r = manager.submit(a, 'hello', 'interference-123456789');
    await manager.tick();
    appendFileSync(file, turn('desktop prompt'));
    await manager.tick();
    expect(manager.store.get(r.id)?.status).toBe('outcome_unknown');
    expect(() => manager.submit(a, 'next', 'next-key-123456789')).toThrow(/handoff/);
    truncateSync(file, 0);
    await manager.tick();
    expect(manager.store.get(r.id)?.status).toBe('outcome_unknown');
  });
  it('blocks after an active deadline and reconciles late completion without replay or automatic handoff', async () => {
    const a = await ready();
    const r = manager.submit(a, 'hello', 'deadline-key-123456789');
    await manager.tick();
    ledger.put({ ...ledger.get(r.id)!, deadline: Date.now() - 1 });
    await manager.tick();
    expect(ledger.get(r.id)?.status).toBe('outcome_unknown');
    expect(allowed()).toBe(false);
    expect(manager.availability(a).requestExecution).toBe(false);
    appendFileSync(file, turn('hello', 'late answer'));
    await manager.tick();
    expect(ledger.get(r.id)?.result?.text).toBe('late answer');
    expect(writes).toHaveLength(1);
    expect(manager.availability(a).requestExecution).toBe(false);
  });
  it('does not attribute a replacement transcript even if its path and native identity match', async () => {
    const a = await ready();
    const r = manager.submit(a, 'hello', 'rotation-key-123456789');
    await manager.tick();
    const original = readFileSync(file, 'utf8');
    renameSync(file, file + '.retained');
    writeFileSync(file, original + turn('hello'));
    await manager.tick();
    expect(ledger.get(r.id)?.status).toBe('outcome_unknown');
    expect(ledger.get(r.id)?.result).toBeUndefined();
    expect(writes).toHaveLength(1);
  });
  it('refuses handoff while the native task is unfinished despite an idle session flag', async () => {
    const a = await ready();
    await manager.takeControl(a);
    const enabled = registry.update(assistants.get(a.id)!, assistants.get(a.id)!.revision, { enabled: true });
    appendFileSync(file, row({ type: 'task_started', turn_id: randomUUID() }));
    await expect(manager.handoff(enabled, enabled.revision, true)).rejects.toThrow(/native|idle|turn/i);
    expect(manager.availability(enabled).requestExecution).toBe(false);
  });
  it('expires queued work without sending, cancels only queued requests, and respects revoked grants', async () => {
    const a = await ready();
    const r = manager.submit(a, 'hello', 'cancel-key-123456789');
    manager.cancel(r);
    await manager.tick();
    expect(writes).toHaveLength(0);
    const expired = manager.submit(a, 'expired', 'expire-key-123456789');
    ledger.put({ ...expired, deadline: Date.now() - 1 });
    await manager.tick();
    expect(manager.store.get(expired.id)?.status).toBe('cancelled');
    validGrant = false;
    const revoked = manager.submit(a, 'revoked', 'revoked-key-123456789');
    await manager.tick();
    expect(manager.store.get(revoked.id)?.status).toBe('cancelled');
    expect(writes).toHaveLength(0);
  });
  it('requires explicit handoff after restart and stops on recovery, automation, or pending input', async () => {
    const a = await ready();
    await manager.stop();
    restart();
    expect(manager.availability(a).requestExecution).toBe(false);
    live.assistantPendingWrites = 1;
    await expect(manager.handoff(a, a.revision, true)).rejects.toThrow(/active input/);
    live.assistantPendingWrites = 0;
    automation = true;
    await expect(manager.handoff(a, a.revision, true)).rejects.toThrow(/automation/);
    automation = false;
    await manager.handoff(a, a.revision, true);
    live.pid = 456;
    expect(manager.availability(a).requestExecution).toBe(false);
  });
  it('waits for async mux submission before Take control and preserves interrupted side effects', async () => {
    const a = await ready();
    const r = manager.submit(a, 'hello', 'takeover-key-123456789');
    let finish!: () => void;
    live.writeViaMux = async () =>
      new Promise<boolean>((resolve) => {
        finish = () => resolve(true);
      });
    const tick = manager.tick();
    while (!finish) await new Promise((resolve) => setTimeout(resolve, 1));
    const takeover = manager.takeControl(a);
    expect(allowed()).toBe(false);
    finish();
    await tick;
    await takeover;
    expect(manager.store.get(r.id)?.status).toBe('interrupted');
    expect(allowed()).toBe(true);
    expect(assistants.get(a.id)?.enabled).toBe(false);
  });
  it('preserves corrupt ledger and never substitutes empty state', () => {
    writeFileSync(join(root, 'requests.json'), '{broken');
    expect(() => new AssistantRequestStore(join(root, 'requests.json'))).toThrow(/unavailable/);
    expect(readFileSync(join(root, 'requests.json'), 'utf8')).toBe('{broken');
  });
});
describe('native projection and API ownership', () => {
  it('does not complete on commentary, idle, partial records, or a different turn', () => {
    expect(observeAssistantTurn('', conversationId, 'hello').state).toBe('waiting');
    expect(observeAssistantTurn(turn('hello', 'comment', 'id', 'commentary'), conversationId, 'hello').state).toBe(
      'unknown'
    );
    expect(observeAssistantTurn(turn('other'), conversationId, 'hello').state).toBe('unknown');
    const data = turn('hello');
    expect(observeAssistantTurn(data.slice(0, -1), conversationId, 'hello').state).toBe('running');
    expect(observeAssistantTurn(data, randomUUID(), 'hello').state).toBe('unknown');
    expect(observeAssistantTurn(data + turn('hello'), conversationId, 'hello').state).toBe('unknown');
  });
  it('conceals request UUIDs belonging to a different assistant and forbids bearer handoff/reconcile', async () => {
    const a = await ready();
    const r = manager.submit(a, 'hello', 'api-owner-123456789');
    const other = registry.create(undefined, 'Other', 'other');
    const token = assistants.issueToken(other, 'other', ['read', 'submit', 'cancel']).token;
    const app = Fastify();
    installRouteErrorHandler(app);
    registerAuthMiddleware(app, false, '', assistants);
    registerAssistantRoutes(app, registry, new Map([[live.id, live]]), manager);
    await app.ready();
    try {
      const headers = { authorization: `Bearer ${token}` };
      expect((await app.inject({ url: `/api/assistant-requests/${r.id}`, headers })).statusCode).toBe(404);
      expect(
        (await app.inject({ method: 'POST', url: `/api/assistant-requests/${r.id}/cancel`, headers })).statusCode
      ).toBe(404);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `/api/assistants/${other.id}/handoff`,
            headers,
            payload: { expectedRevision: 1, composerEmpty: true },
          })
        ).statusCode
      ).toBe(403);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `/api/assistant-requests/${r.id}/reconcile`,
            headers,
            payload: { acknowledgeSideEffects: true },
          })
        ).statusCode
      ).toBe(403);
    } finally {
      await app.close();
    }
  });
  it('gates every shared Session input method, including checkpoint and asynchronous mux writes', async () => {
    const s = new Session({ id: 'guard-test', workingDir: root, mode: 'codex' });
    s.setAssistantInputGuard((permit) => permit === 'internal');
    expect(s.write('hello\r')).toBe(false);
    expect(await s.writeViaMux('hello\r')).toBe(false);
    expect((await s.writeCheckpointViaMux('/new\r')).ok).toBe(false);
    await expect(s.sendInput('hello')).rejects.toThrow(/Assistant/);
    await expect(s.performAuxiliaryInput(async () => {})).rejects.toThrow(/Assistant/);
    expect(s.lastSubmitAt).toBe(0);
    await s.stop(false);
  });
});
