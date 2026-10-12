import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConversationRouter, ROUTING_PROMPT } from './conversation-routing.mjs';
const d = {
  channel: 'whatsapp',
  accountId: 'test',
  chatId: '+15551234567',
  senderId: '+15551234567',
  messageId: 'MSG1',
};
const meeting = 'a'.repeat(64),
  job = 'b'.repeat(64);
const event = (content) => ({ content, channel: 'whatsapp', isGroup: false, commandAuthorized: false });
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'cod514-routing-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'state.json');
  let now = 1791800000000;
  const calls = [];
  let answer = { route: 'brain', parentId: meeting, answerQuestion: false };
  const classify = async (facts) => {
    calls.push(facts);
    if (answer instanceof Error) throw answer;
    return answer;
  };
  const make = () => new ConversationRouter({ path, classify, now: () => now });
  return {
    root,
    path,
    calls,
    make,
    set: (a) => {
      answer = a;
    },
    advance: (ms) => {
      now += ms;
    },
  };
}
async function offer(r) {
  const dest = { ...d, messageId: 'OFFER' };
  await r.decide(event('Brain, find an earlier meeting'), dest, { explicit: true });
  r.accepted(dest, 'Find an earlier meeting with Craig', meeting);
  r.delivered(d, meeting, 'Tuesday 5–5:30 PM is free. Wednesday is still booked.', 'RESULT1');
}
test('new topics default to OpenClaw; semantic follow-up selects the visible meeting unchanged', async (t) => {
  const f = fixture(t),
    r = f.make();
  assert.equal((await r.decide(event('hello'), d)).route, 'openclaw');
  assert.equal(f.calls.length, 0);
  await offer(r);
  const text = 'move to Tuesday';
  const x = await r.decide(event(text), { ...d, messageId: 'MSG2' });
  assert.equal(x.route, 'brain');
  assert.equal(x.parentId, meeting);
  assert.match(x.context.answer, /Tuesday/);
  assert.equal(f.calls[0].message, text);
  assert.equal(f.calls[0].foregroundId, meeting);
  assert.equal(statSync(f.path).mode & 0o777, 0o600);
  assert.match(ROUTING_PROMPT, /OpenClaw is the default/);
});
test('topic changes and explicit names/other quoted messages win; background completion never steals focus', async (t) => {
  const f = fixture(t),
    r = f.make();
  await offer(r);
  r.accepted({ ...d, messageId: 'BJOB' }, 'Run a background maintenance job', job);
  f.set({ route: 'openclaw', parentId: null, answerQuestion: false });
  await r.decide(event('What is the server health?'), { ...d, messageId: 'NEW' });
  const focus = r.chat(d).foregroundId;
  r.delivered(d, job, 'Maintenance job completed', 'BG1');
  assert.equal(r.chat(d).foregroundId, focus);
  const n = f.calls.length;
  f.set({ route: 'brain', parentId: meeting, answerQuestion: false });
  assert.equal((await r.decide(event('new topic: disk usage'), { ...d, messageId: 'SWITCH' })).route, 'openclaw');
  assert.equal(
    (await r.decide(event('yes'), { ...d, messageId: 'OTHERQUOTE', replyToMessageId: 'OTHER_BOT' })).route,
    'openclaw'
  );
  assert.equal(f.calls.length, n);
  assert.equal(
    (await r.decide(event('brain check this'), { ...d, messageId: 'NAMED' }, { explicit: true })).route,
    'brain'
  );
});
test('duplicates freeze semantic routing across restart and reject edited identity; concurrent duplicates classify once', async (t) => {
  const f = fixture(t);
  let r = f.make();
  await offer(r);
  const msg = event('move it to Tuesday'),
    dest = { ...d, messageId: 'MOVE' };
  const [a, b] = await Promise.all([r.decide(msg, dest), r.decide(msg, dest)]);
  assert.deepEqual(a, b);
  assert.equal(f.calls.length, 1);
  f.set({ route: 'openclaw', parentId: null, answerQuestion: false });
  r = f.make();
  assert.equal((await r.decide(msg, dest)).route, 'brain');
  assert.equal(f.calls.length, 1);
  assert.equal((await r.decide(event('move it to Wednesday'), dest)).conflict, true);
});
test('classification errors and invented parents cannot route ambiguous actions to an assistant', async (t) => {
  const f = fixture(t),
    r = f.make();
  await offer(r);
  for (const answer of [
    new Error('timeout'),
    { route: 'brain', parentId: job, answerQuestion: false },
    { route: 'wrong' },
    { route: 'brain', parentId: meeting },
  ]) {
    f.set(answer);
    assert.equal((await r.decide(event('move it'), { ...d, messageId: Math.random().toString() })).route, 'clarify');
  }
  f.set(new Error('timeout'));
  assert.equal(
    (await r.decide(event('OpenClaw, what is server health?'), { ...d, messageId: 'HEALTH' })).route,
    'openclaw'
  );
});
test('clarification selection preserves original multiline text, scope and original request identity across restart', async (t) => {
  const f = fixture(t);
  let r = f.make();
  await offer(r);
  f.set({ route: 'clarify', parentId: null, answerQuestion: false });
  const original = 'move it\r\n\r\nto Tuesday\n';
  const originalD = { ...d, messageId: 'AMBIG' };
  assert.equal((await r.decide(event(original), originalD)).route, 'clarify');
  r = f.make();
  const selected = await r.decide(event('Brain'), { ...d, messageId: 'SELECT' }, { explicit: true });
  assert.equal(selected.route, 'brain');
  assert.equal(selected.original.event.content, original);
  assert.equal(selected.original.destination.messageId, 'AMBIG');
  assert.deepEqual(await r.decide(event('Brain'), { ...d, messageId: 'SELECT' }, { explicit: true }), selected);
  const other = { ...d, chatId: '+15557654321', senderId: '+15557654321', messageId: 'OTHER' };
  assert.equal((await r.decide(event('move it'), other)).route, 'openclaw');
});
test('OpenClaw selection resolves original message and old history expires without sticking to Brain', async (t) => {
  const f = fixture(t),
    r = f.make();
  await offer(r);
  f.set({ route: 'clarify', parentId: null, answerQuestion: false });
  await r.decide(event('do that'), { ...d, messageId: 'AMBIG' });
  const x = await r.decide(event('OpenClaw'), { ...d, messageId: 'CHOICE' });
  assert.equal(x.route, 'openclaw');
  assert.equal(x.original.event.content, 'do that');
  f.advance(7 * 86400000 + 1);
  const n = f.calls.length;
  assert.equal((await r.decide(event('hello again'), { ...d, messageId: 'OLD' })).route, 'openclaw');
  assert.equal(f.calls.length, n);
});
test('a pending native question is selected only by explicit classified answer and exactly one parent', async (t) => {
  const f = fixture(t),
    r = f.make();
  await offer(r);
  f.set({ route: 'brain', parentId: meeting, answerQuestion: true });
  const q = { parentId: meeting, receipt: 'QUESTION1', text: 'Which time?' };
  assert.equal(
    (await r.decide(event('5 PM'), { ...d, messageId: 'ANSWER' }, { pendingQuestions: [q] })).questionReceipt,
    'QUESTION1'
  );
  assert.equal(
    (
      await r.decide(
        event('yes'),
        { ...d, messageId: 'TWO' },
        { pendingQuestions: [q, { ...q, receipt: 'QUESTION2' }] }
      )
    ).route,
    'clarify'
  );
});
test('foreign channel/account/sender context and uncorrelated default-agent output never acquire Brain focus', async (t) => {
  const f = fixture(t),
    r = f.make();
  await offer(r);
  for (const patch of [
    { channel: 'telegram' },
    { accountId: 'other' },
    { senderId: '+15550000000', chatId: '+15550000000' },
  ])
    assert.equal((await r.decide(event('move it'), { ...d, ...patch, messageId: 'OTHER' })).route, 'openclaw');
  const id = r.chat(d).foregroundId;
  r.observeOpenClaw({ success: true, content: 'Maintenance on Tuesday' }, {});
  assert.equal(r.chat(d).foregroundId, id);
});
test('symlink, public file and corrupt state fail closed', async (t) => {
  const f = fixture(t),
    r = f.make();
  await offer(r);
  writeFileSync(f.path, '{}');
  assert.throws(f.make, /corrupt/);
  rmSync(f.path);
  symlinkSync('/dev/null', f.path);
  assert.throws(f.make, /Private/);
});

test('a later topic cancels an old clarification and late Brain acceptance cannot steal its focus', async (t) => {
  const f = fixture(t),
    r = f.make();
  await offer(r);
  f.set({ route: 'clarify', parentId: null, answerQuestion: false });
  await r.decide(event('do that'), { ...d, messageId: 'AMBIG' });
  await r.decide(event('new topic: server health'), { ...d, messageId: 'TOPIC' });
  const x = await r.decide(event('Brain'), { ...d, messageId: 'BARE' }, { explicit: true });
  assert.equal(x.route, 'brain');
  assert.equal(x.original, undefined);
  await r.decide(event('new topic: disk health'), { ...d, messageId: 'NEWER' });
  const id = r.chat(d).foregroundId;
  r.accepted({ ...d, messageId: 'BARE' }, 'a preflight that finished late', job);
  assert.equal(r.chat(d).foregroundId, id);
});

test('yes to a routing clarification is not a new Brain task; quoted selections resolve the exact original', async (t) => {
  const f = fixture(t),
    r = f.make();
  await offer(r);
  f.set({ route: 'clarify', parentId: null, answerQuestion: false });
  const ambiguous = { ...d, messageId: 'AMBIG' };
  await r.decide(event('move it to Tuesday'), ambiguous);
  r.clarified(ambiguous, 'CLARIFY1');
  const yes = { ...d, messageId: 'YES', replyToMessageId: 'CLARIFY1' };
  const again = await r.decide(event('yes'), yes, { quoted: true });
  assert.equal(again.route, 'clarify');
  assert.equal(again.original.event.content, 'move it to Tuesday');
  r.clarified(yes, 'CLARIFY2');
  const choice = await r.decide(
    event('“Brain”'),
    { ...d, messageId: 'CHOICE', replyToMessageId: 'CLARIFY2' },
    { quoted: true }
  );
  assert.equal(choice.route, 'brain');
  assert.equal(choice.original.destination.messageId, 'AMBIG');
  assert.equal(choice.original.event.content, 'move it to Tuesday');
});
