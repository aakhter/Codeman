import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { AssistantStore } from '../src/assistant-store.js';
import { AssistantRegistry } from '../src/assistant-registry.js';
import { AssistantRequestStore } from '../src/assistant-request-store.js';
import { AssistantRequestManager, type AssistantExecutionSession } from '../src/assistant-request-manager.js';
import { AssistantRecovery } from '../src/assistant-recovery.js';
import { observeClaudeAssistantTurn, observeOpenCodeAssistantTurn } from '../src/assistant-turn-observer.js';
import { assistantSessionHome } from '../src/assistant-native.js';
import type { AssistantDefinition } from '../src/types/assistant.js';

const line = (value: unknown) => JSON.stringify(value) + '\n';
const claudeTurn = (conversation: string, prompt: string, answer = 'answer', complete = true) => {
  const user = randomUUID(),
    assistant = randomUUID();
  return (
    line({ type: 'user', uuid: user, parentUuid: null, sessionId: conversation, message: { content: prompt } }) +
    line({
      type: 'assistant',
      uuid: assistant,
      parentUuid: user,
      sessionId: conversation,
      message: { id: randomUUID(), stop_reason: 'end_turn', content: [{ type: 'text', text: answer }] },
    }) +
    (complete ? line({ type: 'system', subtype: 'turn_duration', sessionId: conversation, parentUuid: assistant }) : '')
  );
};
const openCodeTurn = (conversation: string, prompt: string, answer = 'answer', complete = true) =>
  line({
    type: 'opencode_message',
    payload: {
      id: 'msg_user',
      sessionID: conversation,
      role: 'user',
      time: { created: 1 },
      parts: [{ type: 'text', text: prompt }],
    },
  }) +
  line({
    type: 'opencode_message',
    payload: {
      id: 'msg_answer',
      sessionID: conversation,
      role: 'assistant',
      parentID: 'msg_user',
      time: { created: 2, ...(complete ? { completed: 3 } : {}) },
      finish: complete ? 'stop' : undefined,
      parts: [{ type: 'text', text: answer }],
    },
  });

describe('native multi-CLI completion evidence', () => {
  it('requires Claude exact user acceptance, native parent linkage and turn completion', () => {
    const id = randomUUID();
    expect(observeClaudeAssistantTurn(claudeTurn(id, 'prompt'), id, 'prompt')).toMatchObject({
      state: 'completed',
      text: 'answer',
    });
    expect(observeClaudeAssistantTurn(claudeTurn(id, 'prompt', 'answer', false), id, 'prompt')).toMatchObject({
      state: 'running',
    });
    expect(
      observeClaudeAssistantTurn(
        claudeTurn(id, '\n\n<pasted_content id=\"42\">\nprompt\n</pasted_content id=\"42\">\n'),
        id,
        'prompt'
      ).state
    ).toBe('completed');
    expect(
      observeClaudeAssistantTurn(
        claudeTurn(id, '\n\n<pasted_content id=\"42\">\nprompt\n</pasted_content id=\"43\">\n'),
        id,
        'prompt'
      ).state
    ).toBe('unknown');
    expect(observeClaudeAssistantTurn(claudeTurn(id, 'foreign'), id, 'prompt').state).toBe('unknown');
    expect(observeClaudeAssistantTurn(claudeTurn(randomUUID(), 'prompt'), id, 'prompt').state).toBe('unknown');
    expect(observeClaudeAssistantTurn(claudeTurn(id, 'prompt') + claudeTurn(id, 'foreign'), id, 'prompt').state).toBe(
      'unknown'
    );
  });
  it('follows Claude attachment and stop-hook parent links and joins native message blocks', () => {
    const id = randomUUID(),
      user = randomUUID(),
      attachment = randomUUID(),
      first = randomUUID(),
      second = randomUUID(),
      stop = randomUUID(),
      message = randomUUID();
    const raw =
      line({ type: 'user', uuid: user, sessionId: id, message: { content: 'prompt' } }) +
      line({ type: 'attachment', uuid: attachment, parentUuid: user, sessionId: id }) +
      line({
        type: 'assistant',
        uuid: first,
        parentUuid: attachment,
        sessionId: id,
        message: { id: message, stop_reason: 'end_turn', content: [{ type: 'text', text: 'hello ' }] },
      }) +
      line({
        type: 'assistant',
        uuid: second,
        parentUuid: first,
        sessionId: id,
        message: { id: message, stop_reason: 'end_turn', content: [{ type: 'text', text: 'world' }] },
      }) +
      line({ type: 'system', subtype: 'stop_hook_summary', uuid: stop, parentUuid: second, sessionId: id }) +
      line({ type: 'system', subtype: 'turn_duration', parentUuid: stop, sessionId: id });
    expect(observeClaudeAssistantTurn(raw, id, 'prompt')).toMatchObject({ state: 'completed', text: 'hello world' });
    expect(observeClaudeAssistantTurn(raw.replace(attachment, randomUUID()), id, 'prompt').state).toBe('unknown');
  });
  it('does not complete from Claude commentary/tool use or orphan final output', () => {
    const id = randomUUID();
    const raw = claudeTurn(id, 'prompt').replace('end_turn', 'tool_use');
    expect(observeClaudeAssistantTurn(raw, id, 'prompt').state).toBe('unknown');
    expect(
      observeClaudeAssistantTurn(claudeTurn(id, 'prompt').split('\n').slice(1).join('\n'), id, 'prompt').state
    ).toBe('unknown');
  });
  it('requires OpenCode parent/message identity and persisted successful completion', () => {
    const id = 'ses_abc123';
    expect(observeOpenCodeAssistantTurn(openCodeTurn(id, 'prompt'), id, 'prompt')).toMatchObject({
      state: 'completed',
      text: 'answer',
    });
    expect(observeOpenCodeAssistantTurn(openCodeTurn(id, 'prompt', 'answer', false), id, 'prompt').state).toBe(
      'running'
    );
    expect(observeOpenCodeAssistantTurn(openCodeTurn(id, 'foreign'), id, 'prompt').state).toBe('unknown');
    expect(observeOpenCodeAssistantTurn(openCodeTurn('ses_foreign', 'prompt'), id, 'prompt').state).toBe('unknown');
    expect(
      observeOpenCodeAssistantTurn(
        openCodeTurn(id, 'prompt').replace('msg_user","time', 'msg_foreign","time'),
        id,
        'prompt'
      ).state
    ).toBe('unknown');
  });
});

let root: string, home: string, file: string, id: string, store: AssistantStore, ledger: AssistantRequestStore;
let sessions: Map<string, AssistantExecutionSession>,
  manager: AssistantRequestManager,
  writes: string[],
  a: AssistantDefinition;
let db: import('node:sqlite').DatabaseSync | undefined;
let previousXdg: string | undefined;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'assistant-multicli-'));
  home = join(root, 'native');
  store = new AssistantStore(join(root, 'assistants.json'));
  ledger = new AssistantRequestStore(join(root, 'requests.json'));
  sessions = new Map();
  writes = [];
  previousXdg = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = home;
});
afterEach(() => {
  db?.close();
  db = undefined;
  if (previousXdg === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = previousXdg;
  rmSync(root, { recursive: true, force: true });
});
function live(mode: 'claude' | 'opencode', sessionId: string): AssistantExecutionSession {
  return {
    id: sessionId,
    mode,
    pid: 123,
    status: 'idle',
    workingDir: root,
    claudeSessionId: mode === 'claude' ? id : undefined,
    nativeResumeId: mode === 'opencode' ? id : undefined,
    openCodeConfig: mode === 'opencode' ? { continueSession: id } : undefined,
    getCodexHomeOverride: () => undefined,
    getClaudeConfigDirOverride: () => home,
    hasLostCodexProviderCredentials: () => false,
    assistantPendingWrites: 0,
    assistantLastInputAt: 0,
    isCheckpointActive: false,
    setAssistantInputGuard: () => {},
    cancelAssistantSubmitVerification: () => {},
    writeViaMux: async (text) => {
      writes.push(text);
      return true;
    },
  };
}
async function ready(mode: 'claude' | 'opencode') {
  id = mode === 'claude' ? randomUUID() : 'ses_native';
  if (mode === 'claude') {
    const projects = join(home, 'projects', 'test');
    mkdirSync(projects, { recursive: true });
    file = join(projects, `${id}.jsonl`);
    writeFileSync(
      file,
      line({ type: 'user', uuid: randomUUID(), sessionId: id, cwd: root, isMeta: true, message: { content: 'setup' } })
    );
    appendFileSync(file, claudeTurn(id, 'bootstrap', 'done'));
  } else {
    const { DatabaseSync } = await import('node:sqlite');
    mkdirSync(join(home, 'opencode'), { recursive: true });
    file = join(home, 'opencode', 'opencode.db');
    db = new DatabaseSync(file);
    db.exec(
      'CREATE TABLE session(id TEXT PRIMARY KEY,directory TEXT);CREATE TABLE message(id TEXT PRIMARY KEY,session_id TEXT,time_created INTEGER,data TEXT);CREATE TABLE part(id TEXT PRIMARY KEY,session_id TEXT,message_id TEXT,time_created INTEGER,data TEXT);'
    );
    db.prepare('INSERT INTO session VALUES(?,?)').run(id, root);
  }
  const session = live(mode, 'pane');
  sessions.set(session.id, session);
  manager = new AssistantRequestManager(store, ledger, (s) => sessions.get(s));
  const recovery = new AssistantRecovery(
    store,
    manager,
    (s) => sessions.get(s),
    {
      snapshot: () => ({ name: 'helper', mode, codexConfig: {} }),
      create: async (newId) => {
        const next = live(mode, newId);
        sessions.set(newId, next);
        return next;
      },
      composerEmpty: async () => true,
      ownerAllowed: async () => true,
    },
    join(root, 'recovery.json'),
    0
  );
  manager.setRecovery(recovery);
  const registry = new AssistantRegistry(store);
  const created = registry.create(undefined, 'Helper', 'helper');
  const bound = await registry.bind(created, 1, 0, session);
  a = registry.update(bound, bound.revision, { enabled: true });
  await manager.handoff(a, a.revision, true);
}
function insertOpenCodeTurn(prompt: string, answer: string, complete = true) {
  const user = 'msg_' + randomUUID(),
    assistant = 'msg_' + randomUUID();
  db!
    .prepare('INSERT INTO message VALUES(?,?,?,?)')
    .run(user, id, Date.now(), JSON.stringify({ role: 'user', time: { created: 1 } }));
  db!
    .prepare('INSERT INTO part VALUES(?,?,?,?,?)')
    .run('prt_' + randomUUID(), id, user, 1, JSON.stringify({ type: 'text', text: prompt }));
  db!.prepare('INSERT INTO message VALUES(?,?,?,?)').run(
    assistant,
    id,
    Date.now() + 1,
    JSON.stringify({
      role: 'assistant',
      parentID: user,
      time: { created: 2, ...(complete ? { completed: 3 } : {}) },
      finish: complete ? 'stop' : undefined,
    })
  );
  db!
    .prepare('INSERT INTO part VALUES(?,?,?,?,?)')
    .run('prt_' + randomUUID(), id, assistant, 2, JSON.stringify({ type: 'text', text: answer }));
  return assistant;
}
describe.each(['claude', 'opencode'] as const)('%s assistant execution and recovery', (mode) => {
  it('binds, locks input, observes exact completion and resumes the same native conversation', async () => {
    await ready(mode);
    expect(a.mode).toBe(mode);
    expect(a.binding!.mode).toBe(mode);
    expect(assistantSessionHome(sessions.get('pane')!)).toBe(home);
    const request = manager.submit(a, 'request', 'native-key-123456789');
    await manager.tick();
    expect(writes).toEqual(['request\r']);
    expect(manager.inputAllowed('pane')).toBe(false);
    if (mode === 'claude') appendFileSync(file, claudeTurn(id, 'request', 'result'));
    else insertOpenCodeTurn('request', 'result');
    await manager.tick();
    expect(ledger.get(request.id)).toMatchObject({ status: 'completed', result: { text: 'result' } });
    sessions.delete('pane');
    await manager.tick();
    const recovered = store.get(a.id)!;
    expect(recovered.binding).toMatchObject({ mode, conversationId: id, codexHome: home, generation: 2 });
    expect(recovered.binding!.sessionId).not.toBe('pane');
    expect(manager.availability(recovered)).toMatchObject({ requestExecution: true, inputLocked: true });
    expect(writes).toHaveLength(1);
  });
  it('blocks recovery after uncertain dispatch instead of replaying it', async () => {
    await ready(mode);
    const request = manager.submit(a, 'request', 'unknown-key-12345678');
    await manager.tick();
    sessions.delete('pane');
    await manager.tick();
    expect(ledger.get(request.id)?.status).toBe('outcome_unknown');
    expect(writes).toHaveLength(1);
    expect(store.get(a.id)!.binding!.sessionId).toBe('pane');
  });
});
describe('OpenCode durable native updates', () => {
  it('waits for an incomplete assistant message, then observes the same row after completion', async () => {
    await ready('opencode');
    const request = manager.submit(a, 'request', 'updated-key-12345678');
    await manager.tick();
    const answer = insertOpenCodeTurn('request', 'result', false);
    await manager.tick();
    expect(ledger.get(request.id)?.status).toBe('running');
    const message = JSON.parse(
      (db!.prepare('SELECT data FROM message WHERE id=?').get(answer) as { data: string }).data
    );
    message.time.completed = 3;
    message.finish = 'stop';
    db!.prepare('UPDATE message SET data=? WHERE id=?').run(JSON.stringify(message), answer);
    await manager.tick();
    expect(ledger.get(request.id)?.status).toBe('completed');
  });
  it('does not bind an unpinned pane when multiple conversations share its workspace', async () => {
    await ready('opencode');
    db!.prepare('INSERT INTO session VALUES(?,?)').run('ses_other', root);
    const candidate = live('opencode', 'new-pane');
    candidate.nativeResumeId = null;
    candidate.openCodeConfig = {};
    const registry = new AssistantRegistry(store);
    const other = registry.create(undefined, 'Other', 'other');
    await expect(registry.bind(other, 1, 0, candidate)).rejects.toThrow(/ambiguous/);
  });
});
