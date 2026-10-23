import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { CodexInputBridge, codexQuestionKey } from '../src/assistant-codex-input.js';
import { observeAssistantTurn } from '../src/assistant-turn-observer.js';
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

async function daemon(secret = false) {
  const root = mkdtempSync(join(tmpdir(), 'codex-input-'));
  mkdirSync(join(root, 'app-server-control'));
  const server = createServer();
  const ws = new WebSocketServer({ server });
  const q = {
    requestId: 7,
    threadId: 'thread',
    turnId: 'turn',
    itemId: 'item',
    isBlocking: true,
    questions: [{ id: 'color', header: 'Color', question: 'Which color?', isSecret: secret }],
  };
  const sent: Array<Record<string, unknown>> = [];
  ws.on('connection', (socket) =>
    socket.on('message', (bytes) => {
      const v = JSON.parse(bytes.toString());
      sent.push(v);
      if (v.method === 'initialize') socket.send(JSON.stringify({ id: v.id, result: { codexHome: root } }));
      if (v.method === 'thread/read')
        socket.send(
          JSON.stringify({ id: v.id, result: { thread: { id: 'thread', cwd: root, status: { type: 'active' } } } })
        );
      if (v.method === 'thread/resume') {
        socket.send(
          JSON.stringify({ id: 7, method: 'item/tool/requestUserInput', params: { ...q, requestId: undefined } })
        );
        socket.send(JSON.stringify({ id: v.id, result: {} }));
      }
      if (!v.method && v.id === 7)
        socket.send(JSON.stringify({ method: 'serverRequest/resolved', params: { threadId: 'thread', requestId: 7 } }));
    })
  );
  await new Promise<void>((resolve) =>
    server.listen(join(root, 'app-server-control', 'app-server-control.sock'), resolve)
  );
  const bridge = new CodexInputBridge(root, 'thread', root);
  cleanup.push(async () => {
    bridge.close();
    ws.clients.forEach((s) => s.terminate());
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(root, { recursive: true, force: true });
  });
  return { bridge, q, sent };
}
describe('native Codex questions', () => {
  it('replays blocking questions and confirms resolution without starting or steering a turn', async () => {
    const { bridge, sent } = await daemon();
    const [question] = await bridge.inputs('turn');
    expect(question.questions[0].question).toBe('Which color?');
    expect(await bridge.inputs('foreign-turn')).toEqual([]);
    await bridge.answer(question, { color: { answers: ['Purple'] } });
    expect(await bridge.inputs('turn')).toEqual([]);
    expect(sent.some((v) => v.method === 'turn/start' || v.method === 'turn/steer')).toBe(false);
    await expect(bridge.answer(question, { color: { answers: ['Purple'] } })).rejects.toThrow('no longer pending');
  });
  it('question identity includes the native item and turn rather than reusable RPC IDs', () => {
    const q = { requestId: 7, threadId: 't', turnId: 'a', itemId: 'i', isBlocking: true, questions: [] };
    expect(codexQuestionKey(q)).toBe(codexQuestionKey({ ...q, requestId: 8 }));
    expect(codexQuestionKey(q)).not.toBe(codexQuestionKey({ ...q, turnId: 'b' }));
  });
  it('async question is not a final answer and only the recorded native answer client ID is accepted', () => {
    const row = (payload: object) => JSON.stringify({ type: 'event_msg', payload }) + '\n';
    const item = (value: object) => row({ type: 'item_completed', thread_id: 'thread', turn_id: 'turn', item: value });
    const start =
      row({ type: 'task_started', turn_id: 'turn' }) +
      item({ type: 'UserMessage', content: [{ type: 'text', text: 'task' }] });
    const question = item({
      type: 'AgentMessage',
      id: 'call-q',
      phase: 'final_answer',
      delivery: 'async',
      questions: [{ title: 'Which color?' }],
      content: [{ type: 'Text', text: 'Which color?' }],
    });
    expect(observeAssistantTurn(start + question, 'thread', 'task')).toMatchObject({
      state: 'running',
      pendingInput: { kind: 'async', itemId: 'call-q' },
    });
    const answer = item({ type: 'UserMessage', client_id: 'answer-id', content: [{ type: 'text', text: 'Purple' }] });
    const end =
      item({ type: 'AgentMessage', phase: 'final_answer', content: [{ type: 'Text', text: 'done' }] }) +
      row({ type: 'task_complete', turn_id: 'turn', last_agent_message: 'done' });
    expect(observeAssistantTurn(start + question + answer + end, 'thread', 'task')).toMatchObject({ state: 'unknown' });
    expect(
      observeAssistantTurn(start + question + answer + end, 'thread', 'task', [
        { clientId: 'answer-id', text: 'Purple' },
      ])
    ).toEqual({ state: 'completed', turnId: 'turn', text: 'done' });
    expect(
      observeAssistantTurn(start + question + answer + end, 'thread', 'task', [{ clientId: 'wrong', text: 'Purple' }])
    ).toMatchObject({ state: 'unknown' });
  });
});
