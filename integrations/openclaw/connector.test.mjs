import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  unlinkSync,
  statSync,
  symlinkSync,
  truncateSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  Connector,
  Outbox,
  brainRequestText,
  telegramAnswer,
  chunks,
  trustedDestination,
  validateConfig,
} from './connector.mjs';
import plugin from './index.mjs';
import { inboundMedia, stageMedia, MEDIA_LIMITS } from './media.mjs';
const config = {
  baseUrl: 'http://127.0.0.1:3000',
  assistantId: randomUUID(),
  accountId: 'brain-test',
  allowFrom: ['123'],
  tokenEnv: 'BRAIN_TOKEN',
};
const event = { channel: 'telegram', isGroup: false, commandAuthorized: true, content: '/brain test' };
const ctx = {
  channelId: 'telegram',
  accountId: 'brain-test',
  conversationId: '123',
  senderId: '123',
  messageId: '456',
};
function harness(t, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'connector-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'outbox.json');
  const calls = [];
  const sends = [];
  const requestId = randomUUID();
  let status = 'running';
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith(`/assistants/${config.assistantId}`))
      return Response.json({
        success: true,
        data: { id: config.assistantId, enabled: true, capabilities: { requestExecution: true } },
      });
    const key = new Outbox(path).records[0].key;
    return Response.json({
      success: true,
      data: {
        id: requestId,
        assistantId: config.assistantId,
        idempotencyKey: key,
        status,
        result: status === 'completed' ? { text: 'answer'.repeat(1000) } : undefined,
      },
    });
  };
  const make = () =>
    new Connector({
      config,
      outbox: new Outbox(path),
      token: () => `cma_${'a'.repeat(43)}`,
      fetchImpl,
      deliver: async (dest, text) => {
        sends.push({ dest, text });
        return { messageId: `sent-${sends.length}` };
      },
      ...overrides,
    });
  return {
    make,
    path,
    calls,
    sends,
    finish: () => {
      status = 'completed';
    },
  };
}
test('rejects untrusted chats, group messages, missing identity and unsafe origins', () => {
  assert.ok(trustedDestination(event, ctx, config));
  assert.ok(trustedDestination(event, { ...ctx, conversationId: 'telegram:123' }, config));
  for (const bad of [
    { ...ctx, senderId: '999' },
    { ...ctx, conversationId: '-123' },
    { ...ctx, messageId: undefined },
    { ...ctx, accountId: 'other' },
  ])
    assert.equal(trustedDestination(event, bad, config), undefined);
  assert.equal(trustedDestination({ ...event, isGroup: true }, ctx, config), undefined);
  assert.equal(trustedDestination({ ...event, commandAuthorized: false }, ctx, config), undefined);
  assert.throws(() => validateConfig({ ...config, baseUrl: 'http://192.168.1.2' }));
  assert.throws(() => validateConfig({ ...config, baseUrl: 'https://token@example.com' }));
});
test('duplicates submit one stable key and restart delivers only matching completed result', async (t) => {
  const h = harness(t);
  let c = h.make();
  await Promise.all([c.inbound(event, ctx), c.inbound(event, ctx)]);
  assert.equal(c.outbox.records.length, 1);
  await Promise.all([c.tick(), c.tick()]);
  assert.equal(h.calls.filter((v) => v.options.method === 'POST').length, 1);
  assert.equal(h.sends.length, 0);
  c = h.make();
  h.finish();
  await c.tick();
  assert.equal(h.calls.filter((v) => v.options.method === 'POST').length, 1);
  assert.equal(h.sends.map((v) => v.text).join(''), 'answer'.repeat(1000));
  assert.ok(h.sends.every((v) => v.dest.chatId === '123' && v.dest.accountId === 'brain-test'));
  assert.equal(c.outbox.records[0].delivery, 'delivered');
  assert.ok(!readFileSync(h.path, 'utf8').includes('cma_'));
  assert.equal((await c.inbound(event, ctx)).handled, true);
  await c.tick();
  assert.equal(h.sends.length, 2);
});
test('response-loss retries same idempotency key, never new execution identity', async (t) => {
  let attempts = [];
  let c;
  const h = harness(t, {
    fetchImpl: async (url, options) => {
      if (options.method === 'POST') {
        attempts.push(JSON.parse(options.body).idempotencyKey);
        throw new Error('lost response');
      }
      return Response.json({
        success: true,
        data: { id: config.assistantId, enabled: true, capabilities: { requestExecution: true } },
      });
    },
  });
  c = h.make();
  await c.inbound(event, ctx);
  await c.tick();
  c = h.make();
  await c.tick();
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0], attempts[1]);
});
test('delivery timeout or crash is unknown; restart never resubmits or resends', async (t) => {
  const h = harness(t, {
    deliver: async () => {
      throw new Error('timeout');
    },
  });
  let c = h.make();
  await c.inbound(event, ctx);
  h.finish();
  await c.tick();
  assert.equal(c.outbox.records[0].delivery, 'delivery_unknown');
  const count = h.calls.length;
  c = h.make();
  await c.tick();
  assert.equal(h.calls.length, count);
  const r = c.outbox.get(c.outbox.records[0].key);
  r.delivery = 'sending';
  c.outbox.put(r);
  assert.equal(h.make().outbox.records[0].delivery, 'delivery_unknown');
});
test('cross-request result, malformed input, phase 2 absence and unauthorized retrieval fail closed', async (t) => {
  const h = harness(t, {
    fetchImpl: async () =>
      Response.json({
        success: true,
        data: { id: config.assistantId, enabled: true, capabilities: { requestExecution: false } },
      }),
  });
  const c = h.make();
  assert.match((await c.inbound(event, ctx)).reply.text, /paused/);
  assert.equal(c.outbox.records.length, 0);
  assert.match((await c.inbound({ ...event, content: '/brain hello\nother' }, ctx)).reply.text, /one line/);
  assert.deepEqual(await c.inbound(event, { ...ctx, senderId: '999' }), { handled: true });
  assert.throws(
    () =>
      c.request(
        { id: randomUUID(), assistantId: randomUUID(), status: 'completed' },
        { assistantId: config.assistantId, key: 'a'.repeat(64) }
      ),
    /mismatch/
  );
});
test('chunking preserves Unicode and stays within Telegram UTF-16 limit', () => {
  const text = '🐱'.repeat(5000) + '<tag> & markdown **';
  const parts = chunks(text);
  assert.equal(parts.join(''), text);
  assert.ok(parts.every((p) => p.length <= 3500));
});
test('plugin registers the pinned SDK ingress hook and managed service without starting a CLI', () => {
  const hooks = [];
  const services = [];
  plugin.register({
    pluginConfig: config,
    on: (...args) => hooks.push(args),
    registerService: (s) => services.push(s),
  });
  assert.equal(hooks[0][0], 'inbound_claim');
  assert.equal(services[0].id, 'codeman-assistant-outbox');
});

test('concurrent edited message conflicts without replacing the first persisted prompt', async (t) => {
  const h = harness(t);
  const c = h.make();
  const results = await Promise.all([c.inbound(event, ctx), c.inbound({ ...event, content: '/brain edited' }, ctx)]);
  assert.equal(c.outbox.records.length, 1);
  assert.equal(c.outbox.records[0].text, 'test');
  assert.match(results[1].reply.text, /conflict/);
  assert.match(
    (await c.inbound({ ...event, content: '/brain\nother' }, { ...ctx, messageId: '777' })).reply.text,
    /one line/
  );
});
test('cross-request API response stops polling before any Telegram delivery', async (t) => {
  const h = harness(t);
  const c = h.make();
  await c.inbound(event, ctx);
  c.fetch = async () =>
    Response.json({
      success: true,
      data: {
        id: randomUUID(),
        assistantId: randomUUID(),
        idempotencyKey: c.outbox.records[0].key,
        status: 'completed',
        result: { text: 'foreign' },
      },
    });
  await c.tick();
  assert.equal(c.outbox.records[0].delivery, 'stopped');
  assert.equal(h.sends.length, 0);
});

test('cancels pending local work without submission and refuses ambiguous in-flight cancellation', async (t) => {
  const h = harness(t);
  const c = h.make();
  await c.inbound(event, ctx);
  const key = c.outbox.records[0].key;
  c.active.add(key);
  const ambiguous = await c.inbound({ ...event, content: `/brain cancel ${key}` }, { ...ctx, messageId: '777' });
  assert.match(ambiguous.reply.text, /reconciled/);
  c.active.delete(key);
  const cancelled = await c.inbound({ ...event, content: `/brain cancel ${key}` }, { ...ctx, messageId: '778' });
  assert.match(cancelled.reply.text, /Cancelled before submission/);
  await c.tick();
  assert.equal(h.calls.filter((v) => v.options.method === 'POST').length, 0);
  assert.equal(h.make().outbox.records[0].status, 'cancelled');
});

test('ordinary Telegram reply_dispatch routes trusted metadata and short-circuits the model', async (t) => {
  const h = harness(t);
  const originalFetch = globalThis.fetch;
  const originalToken = process.env[config.tokenEnv];
  globalThis.fetch = async () =>
    Response.json({
      success: true,
      data: {
        id: config.assistantId,
        enabled: true,
        capabilities: { requestExecution: true },
      },
    });
  process.env[config.tokenEnv] = `cma_${'a'.repeat(43)}`;
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) delete process.env[config.tokenEnv];
    else process.env[config.tokenEnv] = originalToken;
  });
  const deliveries = [];
  const hooks = new Map();
  let service;
  plugin.register({
    pluginConfig: config,
    on: (name, handler) => hooks.set(name, handler),
    registerService: (value) => {
      service = value;
    },
    runtime: {
      channel: {
        outbound: {
          loadAdapter: async () => ({
            sendText: async (payload) => {
              deliveries.push(payload);
              return { messageId: '1' };
            },
          }),
        },
      },
    },
    logger: { error: () => {} },
  });
  await service.start({ stateDir: h.path.slice(0, h.path.lastIndexOf('/')), config: {} });
  t.after(() => service.stop());
  const handler = hooks.get('reply_dispatch');
  const source = {
    BodyForCommands: 'Brain, test',
    RawBody: 'not canonical',
    Body: 'wrapped text',
    OriginatingChannel: 'telegram',
    AccountId: config.accountId,
    OriginatingTo: 'telegram:123',
    SenderId: '123',
    MessageSid: '456',
    ChatType: 'direct',
    CommandAuthorized: true,
  };
  const replies = [];
  const dispatch = {
    dispatcher: {
      sendFinalReply: (payload) => {
        replies.push(payload);
        return true;
      },
    },
    recordProcessed: () => {},
    markIdle: () => {},
  };
  for (const patch of [
    { CommandAuthorized: false },
    { CommandAuthorized: undefined },
    { SenderId: '999' },
    { OriginatingTo: 'telegram:-123' },
    { AccountId: 'other' },
    { MessageSid: undefined },
    { ChatType: 'group' },
    { ChatType: undefined },
    { MessageThreadId: 123 },
    { InternalTurnSource: 'cron' },
  ]) {
    const result = await handler({ ctx: { ...source, ...patch }, sendPolicy: 'allow' }, dispatch);
    assert.equal(result.handled, true);
    assert.equal(result.queuedFinal, false);
  }
  assert.equal(replies.length, 0);
  for (const patch of [{ sendPolicy: 'deny' }, { suppressUserDelivery: true }, { isTailDispatch: true }]) {
    assert.equal((await handler({ ctx: source, sendPolicy: 'allow', ...patch }, dispatch)).queuedFinal, false);
  }
  assert.equal(
    (await handler({ ctx: { ...source, BodyForCommands: 'hello' }, sendPolicy: 'allow' }, dispatch)).handled,
    false
  );
  assert.equal(
    (await handler({ ctx: { ...source, OriginatingChannel: 'discord' }, sendPolicy: 'allow' }, dispatch)).handled,
    false
  );
  const result = await handler({ ctx: source, sendPolicy: 'allow' }, dispatch);
  assert.equal(result.handled, true);
  assert.equal(result.queuedFinal, true);
  assert.equal(result.counts.final, 1);
  const manual = await handler(
    { ctx: source, sendPolicy: 'allow', suppressUserDelivery: true, sourceReplyDeliveryMode: 'message_tool_only' },
    dispatch
  );
  assert.equal(manual.handled, true);
  assert.equal(manual.queuedFinal, true);
  assert.equal(replies.length, 0);
  assert.equal(deliveries.length, 2);
  assert.equal(deliveries[0].accountId, config.accountId);
  assert.equal(deliveries[0].to, '123');
  assert.match(deliveries[1].text, /already have/);
  for (const patch of [
    { sendPolicy: 'deny' },
    { ctx: { ...source, SenderId: '999' } },
    { ctx: { ...source, MessageThreadId: 123 } },
    { isTailDispatch: true },
  ]) {
    await handler(
      {
        ctx: source,
        sendPolicy: 'allow',
        suppressUserDelivery: true,
        sourceReplyDeliveryMode: 'message_tool_only',
        ...patch,
      },
      dispatch
    );
  }
  assert.equal(deliveries.length, 2);

  assert.match(deliveries[0].text, /On it/);
  assert.equal(
    JSON.parse(readFileSync(join(h.path.slice(0, h.path.lastIndexOf('/')), 'codeman-assistant-outbox.json'), 'utf8'))
      .records[0].text,
    'test'
  );
  await service.stop();
  await service.start({ stateDir: h.path.slice(0, h.path.lastIndexOf('/')), config: {} });
  const followup = await handler(
    {
      ctx: {
        ...source,
        BodyForCommands: 'continue with that option',
        MessageSid: '460',
        ReplyToId: '1',
        ReplyToBody: 'ignored quoted text',
      },
      sendPolicy: 'allow',
    },
    dispatch
  );
  assert.equal(followup.handled, true);
  assert.equal(followup.queuedFinal, true);
  assert.equal(deliveries.length, 3);
  const saved = JSON.parse(
    readFileSync(join(h.path.slice(0, h.path.lastIndexOf('/')), 'codeman-assistant-outbox.json'), 'utf8')
  );
  assert.equal(saved.records[1].text, 'continue with that option');
  assert.equal(saved.replyTargets[0].messageId, '1');
  for (const patch of [{ sendPolicy: 'deny' }, { isTailDispatch: true }, { suppressUserDelivery: true }])
    assert.equal(
      (
        await handler(
          {
            ctx: { ...source, BodyForCommands: 'followup', MessageSid: '461', ReplyToIdFull: '1' },
            sendPolicy: 'allow',
            ...patch,
          },
          dispatch
        )
      ).queuedFinal,
      false
    );
  assert.equal(deliveries.length, 3);
  assert.equal(
    (
      await handler(
        {
          ctx: { ...source, BodyForCommands: 'another question', ReplyToId: '999', ReplyToBody: 'Brain result' },
          sendPolicy: 'allow',
        },
        dispatch
      )
    ).handled,
    false
  );
});

test('manifest explicitly activates the managed connector during gateway startup', () => {
  const manifest = JSON.parse(readFileSync(new URL('./openclaw.plugin.json', import.meta.url), 'utf8'));
  assert.equal(manifest.activation.onStartup, true);
});

test('replies to each delivered result chunk route without a prefix after restart; quote text does not route', async (t) => {
  let n = 900;
  const h = harness(t, { deliver: async () => ({ messageId: String(++n) }) });
  let c = h.make();
  await c.inbound(event, ctx);
  h.finish();
  await c.tick();
  assert.deepEqual(c.outbox.records[0].receipts, ['901', '902']);
  // Legacy result receipts are sufficient; no new reply-target ledger required.
  c = h.make();
  for (const replyToMessageId of ['901', '902']) {
    const id = replyToMessageId === '901' ? '457' : '458';
    const reply = { ...event, content: 'continue with that option' };
    assert.match((await c.inbound(reply, { ...ctx, messageId: id, replyToMessageId })).reply.text, /On it/);
  }
  assert.equal(c.outbox.records.length, 3);
  assert.equal(c.outbox.records[1].text, 'continue with that option');
  assert.equal(
    (
      await c.inbound(
        { ...event, content: 'ordinary question', ReplyToBody: 'Brain result' },
        { ...ctx, messageId: '459', replyToMessageId: '999' }
      )
    ).handled,
    false
  );
  assert.equal(
    (await c.inbound({ ...event, content: 'ordinary question' }, { ...ctx, messageId: '459' })).handled,
    false
  );
});

test('reply ownership rejects unauthorized identities, different chats/accounts, malformed and unknown IDs', async (t) => {
  const h = harness(t),
    c = h.make();
  c.rememberReplyTarget({ accountId: config.accountId, chatId: '123', senderId: '123' }, '901');
  const reply = { ...event, content: 'continue' };
  const identity = { ...ctx, messageId: '457', replyToMessageId: '901' };
  for (const patch of [
    { senderId: '999' },
    { conversationId: '999', senderId: '999' },
    { accountId: 'other' },
    { channelId: 'discord' },
    { messageId: undefined },
    { replyToMessageId: 901 },
    { replyToMessageId: '999' },
    { replyToMessageId: '901:123' },
  ])
    assert.equal((await c.inbound(reply, { ...identity, ...patch })).handled, false);
  for (const patch of [{ commandAuthorized: false }, { isGroup: true }, { threadId: 1 }])
    assert.equal((await c.inbound({ ...reply, ...patch }, identity)).handled, false);
  c.config = { ...c.config, assistantId: randomUUID() };
  assert.equal((await c.inbound(reply, identity)).handled, false);
  assert.equal(h.calls.length, 0);
});

test('acknowledgement reply ownership persists privately, deduplicates and stays bounded', async (t) => {
  const h = harness(t),
    c = h.make();
  const dest = { accountId: config.accountId, chatId: '123', senderId: '123' };
  c.rememberReplyTarget(dest, '901');
  c.rememberReplyTarget(dest, '901');
  assert.equal(c.outbox.replyTargets.length, 1);
  const restarted = h.make();
  assert.match(
    (await restarted.inbound({ ...event, content: 'follow up' }, { ...ctx, messageId: '457', replyToMessageId: '901' }))
      .reply.text,
    /On it/
  );
  assert.equal(statSync(h.path).mode & 0o777, 0o600);
  const retained = Array.from({ length: 2000 }, (_, i) => ({
    assistantId: config.assistantId,
    destination: dest,
    messageId: String(i + 1000),
  }));
  restarted.outbox.persist(restarted.outbox.records, retained);
  restarted.rememberReplyTarget(dest, '9999');
  assert.equal(restarted.outbox.replyTargets.length, 2000);
  assert.equal(restarted.outbox.replyTargets[0].messageId, '1001');
  assert.equal(h.make().outbox.replyTargets.at(-1).messageId, '9999');
});

test('corrupt reply ownership is rejected instead of guessing routing', (t) => {
  const h = harness(t);
  for (const replyTargets of [
    [null],
    [
      {
        assistantId: config.assistantId,
        messageId: '901',
        destination: { accountId: config.accountId, chatId: '123', senderId: '999' },
      },
    ],
    Array(2).fill({
      assistantId: config.assistantId,
      messageId: '901',
      destination: { accountId: config.accountId, chatId: '123', senderId: '123' },
    }),
  ]) {
    writeFileSync(h.path, JSON.stringify({ version: 1, records: [], replyTargets }));
    assert.throws(() => h.make(), /corrupt/);
  }
});

test('acknowledgement failure keeps the request claimed and never falls back to the model', async (t) => {
  const h = harness(t),
    hooks = new Map();
  let service;
  const originalFetch = globalThis.fetch,
    originalToken = process.env[config.tokenEnv];
  globalThis.fetch = async () =>
    Response.json({
      success: true,
      data: { id: config.assistantId, enabled: true, capabilities: { requestExecution: true } },
    });
  process.env[config.tokenEnv] = `cma_${'a'.repeat(43)}`;
  t.after(async () => {
    await service?.stop();
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) delete process.env[config.tokenEnv];
    else process.env[config.tokenEnv] = originalToken;
  });
  const errors = [];
  plugin.register({
    pluginConfig: config,
    on: (n, handler) => hooks.set(n, handler),
    registerService: (s) => {
      service = s;
    },
    logger: { error: (e) => errors.push(e) },
    runtime: {
      channel: {
        outbound: {
          loadAdapter: async () => ({
            sendText: async () => {
              throw Error('network failure');
            },
          }),
        },
      },
    },
  });
  const stateDir = h.path.slice(0, h.path.lastIndexOf('/'));
  await service.start({ stateDir, config: {} });
  const source = {
    BodyForCommands: 'brain do this',
    OriginatingChannel: 'telegram',
    AccountId: config.accountId,
    OriginatingTo: 'telegram:123',
    SenderId: '123',
    MessageSid: '456',
    ChatType: 'direct',
    CommandAuthorized: true,
  };
  const result = await hooks.get('reply_dispatch')(
    { ctx: source, sendPolicy: 'allow' },
    {
      dispatcher: {
        sendFinalReply: () => {
          throw Error('must not invoke dispatcher');
        },
      },
      recordProcessed: () => {},
      markIdle: () => {},
    }
  );
  assert.equal(result.handled, true);
  assert.equal(result.queuedFinal, false);
  assert.equal(errors.length, 1);
  assert.equal(new Outbox(join(stateDir, 'codeman-assistant-outbox.json')).records.length, 1);
});

test('natural Brain addressing stays explicit and preserves the request text', () => {
  for (const prefix of ['brain ', 'Brain, ', 'BRAIN: ', '/brain '])
    assert.equal(brainRequestText(prefix + 'summarize my notes'), 'summarize my notes');
  for (const text of ['brainstorm ideas', 'my brain notes', 'brainwork task', 'brainless', '/brainstorm test'])
    assert.equal(brainRequestText(text), undefined);
  assert.equal(brainRequestText('brain'), '');
});

test('Telegram presentation hides only the known leading memory status banner', () => {
  const banner =
    'Mem0 Active | user=test (override; default: ubuntu) | project=brain | branch=unknown | memories=594\n';
  assert.equal(telegramAnswer(banner + 'BRAIN_CONNECTED_OK'), 'BRAIN_CONNECTED_OK');
  assert.equal(telegramAnswer('My answer\n' + banner), 'My answer\n' + banner);
  assert.equal(telegramAnswer('Mem0 Active is useful\nDetails'), 'Mem0 Active is useful\nDetails');
  assert.equal(telegramAnswer(banner), banner);
});

test('plain Brain requests acknowledge simply and latest controls remain scoped to their chat', async (t) => {
  const h = harness(t);
  const c = h.make();
  const accepted = await c.inbound({ ...event, content: 'Brain, summarize my notes' }, ctx);
  assert.equal(accepted.reply.text, 'On it — sending this to Brain.');
  assert.equal(c.outbox.records[0].text, 'summarize my notes');
  assert.doesNotMatch(accepted.reply.text, /[a-f0-9]{64}/);
  assert.equal(
    (await c.inbound({ ...event, content: 'brain status' }, { ...ctx, messageId: '457' })).reply.text,
    'Your latest request is waiting for Brain.'
  );
  assert.match(
    (await c.inbound({ ...event, content: 'brain result' }, { ...ctx, messageId: '458' })).reply.text,
    /No completed result/
  );
  assert.equal(
    (await c.inbound({ ...event, content: 'brain cancel' }, { ...ctx, messageId: '459' })).reply.text,
    'Cancelled before submission to Codeman.'
  );
  assert.equal(c.outbox.records[0].status, 'cancelled');
  assert.equal(
    (await c.inbound({ ...event, content: 'brain summarize notes' }, { ...ctx, senderId: '999' })).reply,
    undefined
  );
  c.config.allowFrom.push('999');
  assert.match(
    (await c.inbound({ ...event, content: 'brain status' }, { ...ctx, senderId: '999', conversationId: '999' })).reply
      .text,
    /No matching Brain request/
  );
  assert.equal(c.outbox.records.length, 1);
});

function mediaFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'brain-media-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const mediaRoot = join(root, 'inbound');
  const workingDir = join(root, 'workspace');
  mkdirSync(mediaRoot, { mode: 0o700 });
  mkdirSync(workingDir, { mode: 0o700 });
  const path = join(mediaRoot, 'photo.png');
  writeFileSync(path, 'trusted bytes');
  return {
    root,
    mediaRoot,
    workingDir,
    path,
    text: 'explain this',
    media: [{ path, type: 'image/png', name: 'photo.png' }],
    key: 'a'.repeat(64),
    baseUrl: config.baseUrl,
  };
}
test('current and legacy SDK media facts preserve ordering and reject unavailable downloads', () => {
  assert.deepEqual(
    inboundMedia({
      media: [
        { path: '/one', contentType: 'image/png', fileName: 'a.png' },
        { path: '/two', kind: 'document' },
      ],
    }),
    [
      { path: '/one', type: 'image/png', name: 'a.png' },
      { path: '/two', type: 'document', name: undefined },
    ]
  );
  assert.deepEqual(inboundMedia({ MediaPaths: ['/one', '/two'], MediaTypes: ['image/png', 'application/pdf'] }), [
    { path: '/one', type: 'image/png' },
    { path: '/two', type: 'application/pdf' },
  ]);
  assert.deepEqual(inboundMedia({ metadata: { mediaPath: '/one', mediaType: 'image/png' } }), [
    { path: '/one', type: 'image/png' },
  ]);
  assert.throws(() => inboundMedia({ MediaUrl: 'https://example.com/file' }), /download/);
  assert.throws(() => inboundMedia({ mediaStagingPending: true }), /downloading/);
});
test('staging creates private durable files, survives source expiry, and recovers a pre-acceptance copy', (t) => {
  const f = mediaFixture(t);
  const prompt = stageMedia(f);
  const saved = /at "([^"]+)"/.exec(prompt)[1];
  assert.equal(readFileSync(saved, 'utf8'), 'trusted bytes');
  assert.equal(statSync(saved).mode & 0o777, 0o600);
  assert.equal(statSync(join(f.workingDir, '.codeman-telegram')).mode & 0o777, 0o700);
  assert.equal(stageMedia(f), prompt);
  unlinkSync(f.path);
  assert.equal(readFileSync(saved, 'utf8'), 'trusted bytes');
  assert.match(prompt, /file and image tools/);
});
test('staging rejects unsafe sources, destination symlinks, missing files and bounded file sizes', (t) => {
  const f = mediaFixture(t);
  const outside = join(f.root, 'secret');
  writeFileSync(outside, 'must not forward');
  const link = join(f.mediaRoot, 'link.png');
  symlinkSync(outside, link);
  for (const path of [outside, link, join(f.mediaRoot, 'missing'), 'https://example.com/photo', '../secret'])
    assert.throws(() => stageMedia({ ...f, media: [{ path }] }));
  assert.throws(() => stageMedia({ ...f, mediaRoot: undefined }), /local/);
  assert.throws(() => stageMedia({ ...f, baseUrl: 'https://codeman.example.com' }), /local/);
  assert.throws(() => stageMedia({ ...f, media: Array(11).fill(f.media[0]) }), /10 files/);
  truncateSync(f.path, MEDIA_LIMITS.fileBytes + 1);
  assert.throws(() => stageMedia(f), /20 MB/);
  writeFileSync(f.path, 'bytes');
  symlinkSync(f.mediaRoot, join(f.workingDir, '.codeman-telegram'));
  assert.throws(() => stageMedia(f), /folder needs attention/);
});
test('authorized media submission is durable and duplicate retries never need temporary downloads', async (t) => {
  const f = mediaFixture(t);
  const h = harness(t, {
    config: { ...config, mediaRoot: f.mediaRoot },
    fetchImpl: async (url, options) => {
      h.calls.push({ url, options });
      if (options.method === 'GET')
        return Response.json({
          success: true,
          data: {
            id: config.assistantId,
            enabled: true,
            capabilities: { requestExecution: true },
            binding: { workingDir: f.workingDir },
          },
        });
      return Response.json({
        success: true,
        data: {
          id: randomUUID(),
          assistantId: config.assistantId,
          idempotencyKey: JSON.parse(options.body).idempotencyKey,
          status: 'queued',
        },
      });
    },
  });
  let c = h.make();
  const message = { ...event, content: 'Brain, explain this', media: [{ path: f.path, contentType: 'image/png' }] };
  const ack = await c.inbound(message, ctx);
  assert.match(ack.reply.text, /On it/);
  assert.equal(c.outbox.records.length, 1);
  assert.match(c.outbox.records[0].text, /file and image tools/);
  unlinkSync(f.path);
  c = h.make();
  assert.match((await c.inbound(message, ctx)).reply.text, /already have/);
  await c.tick();
  assert.equal(h.calls.filter((v) => v.options.method === 'POST').length, 1);
  assert.match(JSON.parse(h.calls.find((v) => v.options.method === 'POST').options.body).text, /\.codeman-telegram/);
  assert.match(
    (await c.inbound({ ...message, media: [{ path: join(f.mediaRoot, 'different') }] }, ctx)).reply.text,
    /conflict/
  );
});
test('attachments require trusted identity and failed staging never submits a caption alone', async (t) => {
  const f = mediaFixture(t);
  const h = harness(t, { config: { ...config, mediaRoot: f.mediaRoot } });
  const c = h.make();
  const message = { ...event, media: [{ path: f.path }] };
  assert.equal((await c.inbound(message, { ...ctx, senderId: '999' })).reply, undefined);
  assert.equal(h.calls.length, 0);
  assert.match((await c.inbound(message, ctx)).reply.text, /local Brain connection/);
  assert.equal(c.outbox.records.length, 0);
  await c.tick();
  assert.equal(h.calls.filter((v) => v.options.method === 'POST').length, 0);
});

test('attachment aggregate and retained-storage budgets fail before acceptance', (t) => {
  const f = mediaFixture(t);
  truncateSync(f.path, MEDIA_LIMITS.fileBytes);
  assert.throws(() => stageMedia({ ...f, media: Array(3).fill(f.media[0]) }), /40 MB/);
  writeFileSync(f.path, 'bytes');
  const storage = join(f.workingDir, '.codeman-telegram');
  mkdirSync(storage, { mode: 0o700 });
  const prior = join(storage, 'prior-completed-request');
  mkdirSync(prior, { mode: 0o700 });
  const retained = join(prior, 'old-file');
  writeFileSync(retained, 'x', { mode: 0o600 });
  truncateSync(retained, MEDIA_LIMITS.retainedBytes);
  assert.throws(() => stageMedia(f), /storage is full/);
  assert.equal(statSync(retained).size, MEDIA_LIMITS.retainedBytes);
});

test('transient Telegram failure retries after persisted backoff without replaying Codeman or acknowledged chunks', async (t) => {
  let clock = 10000;
  let attempts = 0;
  const delivered = [];
  const h = harness(t, {
    now: () => clock,
    deliver: async (_, text) => {
      attempts++;
      if (attempts === 2) throw new Error("Network request for 'sendMessage' failed!");
      delivered.push(text);
      return { messageId: String(attempts) };
    },
  });
  let c = h.make();
  await c.inbound(event, ctx);
  h.finish();
  await c.tick();
  assert.equal(c.outbox.records[0].delivery, 'retrying');
  assert.equal(c.outbox.records[0].receipts.length, 1);
  assert.equal(c.outbox.records[0].retryAt, 15000);
  const posts = h.calls.filter((x) => x.options.method === 'POST').length;
  c = h.make();
  await c.tick();
  assert.equal(attempts, 2);
  clock = 15000;
  await c.tick();
  assert.equal(c.outbox.records[0].delivery, 'delivered');
  assert.equal(c.outbox.records[0].receipts.length, 2);
  assert.equal(delivered.length, 2);
  assert.equal(h.calls.filter((x) => x.options.method === 'POST').length, posts);
});
test('repeated network failures exhaust five delayed retries across restarts', async (t) => {
  let clock = 10000,
    attempts = 0;
  const h = harness(t, {
    now: () => clock,
    deliver: async () => {
      attempts++;
      throw new Error('fetch failed');
    },
  });
  let c = h.make();
  await c.inbound(event, ctx);
  h.finish();
  for (let i = 0; i < 6; i++) {
    await c.tick();
    const r = c.outbox.records[0];
    if (i < 5) {
      assert.equal(r.delivery, 'retrying');
      clock = r.retryAt;
      c = h.make();
    }
  }
  assert.equal(attempts, 6);
  assert.equal(c.outbox.records[0].delivery, 'delivery_unknown');
  c = h.make();
  clock += 1000000;
  await c.tick();
  assert.equal(attempts, 6);
  assert.equal(h.calls.filter((x) => x.options.method === 'POST').length, 1);
});
test('rate limits honor retry_after and permanent errors do not retry', async (t) => {
  for (const code of [429, 403]) {
    const h = harness(t, {
      now: () => 10000,
      deliver: async () => {
        throw Object.assign(new Error('Telegram refused'), { error_code: code, parameters: { retry_after: 30 } });
      },
    });
    const c = h.make();
    await c.inbound(event, ctx);
    h.finish();
    await c.tick();
    assert.equal(c.outbox.records[0].delivery, code === 429 ? 'retrying' : 'delivery_unknown');
    if (code === 429) assert.equal(c.outbox.records[0].retryAt, 40000);
  }
});
test('a crash during a retry send remains uncertain and is not automatically resent', async (t) => {
  const h = harness(t, {
    deliver: async () => {
      throw new Error('fetch failed');
    },
  });
  const c = h.make();
  await c.inbound(event, ctx);
  h.finish();
  await c.tick();
  const r = c.outbox.get(c.outbox.records[0].key);
  r.delivery = 'sending';
  delete r.retryAt;
  c.outbox.put(r);
  const restarted = h.make();
  await restarted.tick();
  assert.equal(restarted.outbox.records[0].delivery, 'delivery_unknown');
});

test('wrapped Telegram permanent HTTP failures remain stopped despite network error wording', async (t) => {
  const h = harness(t, {
    deliver: async () => {
      throw Object.assign(new Error("Network request for 'sendMessage' failed! (403: Forbidden)"), {
        error: { status: 403 },
      });
    },
  });
  const c = h.make();
  await c.inbound(event, ctx);
  h.finish();
  await c.tick();
  assert.equal(c.outbox.records[0].delivery, 'delivery_unknown');
});
test('malformed retry metadata fails closed when loading the durable outbox', async (t) => {
  const h = harness(t, {
    deliver: async () => {
      throw new Error('fetch failed');
    },
  });
  const c = h.make();
  await c.inbound(event, ctx);
  h.finish();
  await c.tick();
  const original = readFileSync(h.path, 'utf8');
  for (const patch of [
    { deliveryFailures: 7 },
    { deliveryFailures: 1.5 },
    { retryAt: -1 },
    { retryAt: 1.5 },
    { requestId: undefined },
    { receipts: ['done-1', 'done-2'] },
  ]) {
    const j = JSON.parse(original);
    Object.assign(j.records[0], patch);
    writeFileSync(h.path, JSON.stringify(j));
    assert.throws(() => new Outbox(h.path), /corrupt/);
  }
});

const waConfig = { ...config, whatsapp: { accountId: 'wa-test', allowFrom: ['+15551234567'] } };
const waEvent = { ...event, channel: 'whatsapp', commandAuthorized: false, content: 'brain test' };
const waCtx = {
  channelId: 'whatsapp',
  accountId: 'wa-test',
  conversationId: '+15551234567',
  senderId: '+15551234567',
  messageId: '3EB01234ABCD',
};

test('WhatsApp accepts only explicitly allowed private phone identities and valid message IDs', () => {
  assert.ok(trustedDestination(waEvent, waCtx, waConfig));
  assert.ok(trustedDestination(waEvent, { ...waCtx, conversationId: 'whatsapp:+15551234567' }, waConfig));
  assert.equal(trustedDestination(waEvent, waCtx, config), undefined);
  for (const patch of [
    { senderId: '+15559999999' },
    { conversationId: '15551234567@s.whatsapp.net' },
    { conversationId: '123@g.us' },
    { accountId: 'other' },
    { messageId: undefined },
    { messageId: 'abc\nunsafe' },
    { messageId: 'x'.repeat(129) },
  ])
    assert.equal(trustedDestination(waEvent, { ...waCtx, ...patch }, waConfig), undefined);
  for (const patch of [{ isGroup: true }, { threadId: '1' }, { channel: 'telegram' }])
    assert.equal(trustedDestination({ ...waEvent, ...patch }, waCtx, waConfig), undefined);
  for (const allowFrom of [['*'], ['15551234567'], ['+15551234567@s.whatsapp.net']])
    assert.throws(() => validateConfig({ ...config, whatsapp: { accountId: 'wa-test', allowFrom } }));
});

test('WhatsApp durable retries and receipt-backed replies survive restart without task replay', async (t) => {
  let clock = 10000,
    attempts = 0;
  const h = harness(t, {
    config: waConfig,
    now: () => clock,
    deliver: async () => {
      if (++attempts === 2) throw Object.assign(new Error('Connection Closed'), { output: { statusCode: 503 } });
      return { messageId: `3EB0RESULT${attempts}` };
    },
  });
  let c = h.make();
  await Promise.all([c.inbound(waEvent, waCtx), c.inbound(waEvent, waCtx)]);
  h.finish();
  await c.tick();
  assert.equal(c.outbox.records[0].delivery, 'retrying');
  assert.equal(c.outbox.records[0].receipts.length, 1);
  c = h.make();
  clock = 15000;
  await c.tick();
  assert.equal(c.outbox.records[0].delivery, 'delivered');
  assert.equal(h.calls.filter((x) => x.options.method === 'POST').length, 1);
  assert.equal(
    c.addressedText({ ...waEvent, content: 'follow up' }, { ...waCtx, replyToMessageId: '3EB0RESULT1' }),
    'follow up'
  );
  assert.equal(
    c.addressedText(
      { ...waEvent, content: 'follow up' },
      { ...waCtx, accountId: 'other', replyToMessageId: '3EB0RESULT1' }
    ),
    undefined
  );
  c.rememberReplyTarget(c.outbox.records[0].destination, '3EB0ACK');
  c = h.make();
  assert.equal(
    c.addressedText({ ...waEvent, content: 'follow up' }, { ...waCtx, replyToMessageId: '3EB0ACK' }),
    'follow up'
  );
});

test('reply ownership and corruption validation are channel scoped with legacy Telegram compatibility', (t) => {
  const h = harness(t, { config: waConfig });
  const c = h.make();
  c.rememberReplyTarget({ accountId: config.accountId, chatId: '123', senderId: '123' }, '789');
  assert.equal(
    h.make().addressedText({ ...event, content: 'follow up' }, { ...ctx, replyToMessageId: '789' }),
    'follow up'
  );
  const d = trustedDestination(waEvent, waCtx, waConfig);
  c.rememberReplyTarget(d, '789');
  assert.equal(c.outbox.replyTargets.length, 2);
  const saved = JSON.parse(readFileSync(h.path, 'utf8'));
  saved.replyTargets[1].destination.channel = 'discord';
  writeFileSync(h.path, JSON.stringify(saved));
  assert.throws(() => new Outbox(h.path), /corrupt/);
});
test('ordinary WhatsApp reply_dispatch routes trusted metadata and short-circuits the model', async (t) => {
  const h = harness(t);
  const originalFetch = globalThis.fetch;
  const originalToken = process.env[config.tokenEnv];
  globalThis.fetch = async () =>
    Response.json({
      success: true,
      data: {
        id: config.assistantId,
        enabled: true,
        capabilities: { requestExecution: true },
      },
    });
  process.env[config.tokenEnv] = `cma_${'a'.repeat(43)}`;
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) delete process.env[config.tokenEnv];
    else process.env[config.tokenEnv] = originalToken;
  });
  const deliveries = [];
  const hooks = new Map();
  let service;
  plugin.register({
    pluginConfig: waConfig,
    on: (name, handler) => hooks.set(name, handler),
    registerService: (value) => {
      service = value;
    },
    runtime: {
      channel: {
        outbound: {
          loadAdapter: async (channel) => {
            assert.equal(channel, 'whatsapp');
            return {
              sendText: async (payload) => {
                deliveries.push(payload);
                return { messageId: '1' };
              },
            };
          },
        },
      },
    },
    logger: { error: () => {} },
  });
  await service.start({ stateDir: h.path.slice(0, h.path.lastIndexOf('/')), config: {} });
  t.after(() => service.stop());
  const handler = hooks.get('reply_dispatch');
  const source = {
    BodyForCommands: 'Brain, test',
    RawBody: 'not canonical',
    Body: 'wrapped text',
    OriginatingChannel: 'whatsapp',
    AccountId: 'wa-test',
    OriginatingTo: 'whatsapp:+15551234567',
    SenderId: '+15551234567',
    MessageSid: '3EB01234ABCD',
    ChatType: 'direct',
    CommandAuthorized: false,
  };
  const replies = [];
  const dispatch = {
    dispatcher: {
      sendFinalReply: (payload) => {
        replies.push(payload);
        return true;
      },
    },
    recordProcessed: () => {},
    markIdle: () => {},
  };
  for (const patch of [
    { CommandAuthorized: false, BodyForCommands: '/brain test' },
    { CommandAuthorized: undefined, BodyForCommands: '/brain test' },
    { SenderId: '999' },
    { OriginatingTo: 'telegram:-123' },
    { AccountId: 'other' },
    { MessageSid: undefined },
    { ChatType: 'group' },
    { ChatType: undefined },
    { MessageThreadId: 123 },
    { InternalTurnSource: 'cron' },
  ]) {
    const result = await handler({ ctx: { ...source, ...patch }, sendPolicy: 'allow' }, dispatch);
    assert.equal(result.handled, true);
    assert.equal(result.queuedFinal, false);
  }
  assert.equal(replies.length, 0);
  for (const patch of [{ sendPolicy: 'deny' }, { suppressUserDelivery: true }, { isTailDispatch: true }]) {
    assert.equal((await handler({ ctx: source, sendPolicy: 'allow', ...patch }, dispatch)).queuedFinal, false);
  }
  assert.equal(
    (await handler({ ctx: { ...source, BodyForCommands: 'hello' }, sendPolicy: 'allow' }, dispatch)).handled,
    false
  );
  assert.equal(
    (await handler({ ctx: { ...source, OriginatingChannel: 'discord' }, sendPolicy: 'allow' }, dispatch)).handled,
    false
  );
  const result = await handler({ ctx: source, sendPolicy: 'allow' }, dispatch);
  assert.equal(result.handled, true);
  assert.equal(result.queuedFinal, true);
  assert.equal(result.counts.final, 1);
  const manual = await handler(
    { ctx: source, sendPolicy: 'allow', suppressUserDelivery: true, sourceReplyDeliveryMode: 'message_tool_only' },
    dispatch
  );
  assert.equal(manual.handled, true);
  assert.equal(manual.queuedFinal, true);
  assert.equal(replies.length, 0);
  assert.equal(deliveries.length, 2);
  assert.equal(deliveries[0].accountId, 'wa-test');
  assert.equal(deliveries[0].to, '+15551234567');
  assert.match(deliveries[1].text, /already have/);
  for (const patch of [
    { sendPolicy: 'deny' },
    { ctx: { ...source, SenderId: '999' } },
    { ctx: { ...source, MessageThreadId: 123 } },
    { isTailDispatch: true },
  ]) {
    await handler(
      {
        ctx: source,
        sendPolicy: 'allow',
        suppressUserDelivery: true,
        sourceReplyDeliveryMode: 'message_tool_only',
        ...patch,
      },
      dispatch
    );
  }
  assert.equal(deliveries.length, 2);

  assert.match(deliveries[0].text, /On it/);
  assert.equal(
    JSON.parse(readFileSync(join(h.path.slice(0, h.path.lastIndexOf('/')), 'codeman-assistant-outbox.json'), 'utf8'))
      .records[0].text,
    'test'
  );
  await service.stop();
  await service.start({ stateDir: h.path.slice(0, h.path.lastIndexOf('/')), config: {} });
  const followup = await handler(
    {
      ctx: {
        ...source,
        BodyForCommands: 'continue with that option',
        MessageSid: '460',
        ReplyToId: '1',
        ReplyToBody: 'ignored quoted text',
      },
      sendPolicy: 'allow',
    },
    dispatch
  );
  assert.equal(followup.handled, true);
  assert.equal(followup.queuedFinal, true);
  assert.equal(deliveries.length, 3);
  const saved = JSON.parse(
    readFileSync(join(h.path.slice(0, h.path.lastIndexOf('/')), 'codeman-assistant-outbox.json'), 'utf8')
  );
  assert.equal(saved.records[1].text, 'continue with that option');
  assert.equal(saved.replyTargets[0].messageId, '1');
  for (const patch of [{ sendPolicy: 'deny' }, { isTailDispatch: true }, { suppressUserDelivery: true }])
    assert.equal(
      (
        await handler(
          {
            ctx: { ...source, BodyForCommands: 'followup', MessageSid: '461', ReplyToIdFull: '1' },
            sendPolicy: 'allow',
            ...patch,
          },
          dispatch
        )
      ).queuedFinal,
      false
    );
  assert.equal(deliveries.length, 3);
  assert.equal(
    (
      await handler(
        {
          ctx: { ...source, BodyForCommands: 'another question', ReplyToId: '999', ReplyToBody: 'Brain result' },
          sendPolicy: 'allow',
        },
        dispatch
      )
    ).handled,
    false
  );
});

test('formatted CSV answer parts remain frozen across retry/restart and legacy partial deliveries stay intact', async (t) => {
  let clock = 10000,
    attempts = 0;
  const h = harness(t, {
    config: waConfig,
    now: () => clock,
    deliver: async (_, part) => {
      if (typeof part !== 'string' && ++attempts === 1) throw new Error('Connection Closed');
      return { messageId: typeof part === 'string' ? 'TEXT01' : 'CSV01' };
    },
  });
  let c = h.make();
  await c.inbound(waEvent, waCtx);
  const requestId = randomUUID();
  const text =
    '| Name | Status |\n| --- | --- |\n' + Array.from({ length: 9 }, (_, i) => `| Row ${i} | Ready |`).join('\n');
  c.fetch = async () =>
    Response.json({
      success: true,
      data: {
        id: requestId,
        assistantId: config.assistantId,
        idempotencyKey: c.outbox.records[0].key,
        status: 'completed',
        result: { text },
      },
    });
  await c.tick();
  const saved = new Outbox(h.path).records[0];
  assert.equal(saved.delivery, 'retrying');
  assert.equal(saved.receipts.length, 1);
  assert.equal(saved.parts[1].kind, 'csv');
  c = h.make();
  c.fetch = async () =>
    Response.json({
      success: true,
      data: {
        id: requestId,
        assistantId: config.assistantId,
        idempotencyKey: saved.key,
        status: 'completed',
        result: { text: 'Changed output must not replace persisted chunks' },
      },
    });
  clock = saved.retryAt;
  await c.tick();
  assert.deepEqual(c.outbox.records[0].parts, saved.parts);
  assert.equal(c.outbox.records[0].delivery, 'delivered');
  assert.equal(attempts, 2);
  assert.equal(
    c.addressedText({ ...waEvent, content: 'follow up' }, { ...waCtx, replyToMessageId: 'CSV01' }),
    'follow up'
  );
  const result = await c.inbound({ ...waEvent, content: 'brain result' }, { ...waCtx, messageId: 'RESULT01' });
  assert.equal(result.reply.parts[1].kind, 'csv');
});

test('WhatsApp result exports use private temporary files, document receipts and cleanup', async (t) => {
  const h = harness(t, { config: waConfig });
  const c = h.make();
  await c.inbound(waEvent, waCtx);
  const record = c.outbox.records[0];
  record.requestId = randomUUID();
  record.status = 'completed';
  record.delivery = 'delivered';
  record.parts = ['Preview', { kind: 'csv', name: 'brain-table-1.csv', data: '"Name","Value"\r\n"Brain","Ready"\r\n' }];
  record.receipts = ['PREVIEW01', 'CSV01'];
  delete record.text;
  c.outbox.put(record);
  const stateDir = h.path.slice(0, h.path.lastIndexOf('/'));
  writeFileSync(join(stateDir, 'codeman-assistant-outbox.json'), readFileSync(h.path), { mode: 0o600 });
  const originalFetch = globalThis.fetch,
    originalToken = process.env[config.tokenEnv];
  globalThis.fetch = async () =>
    Response.json({
      success: true,
      data: {
        id: record.requestId,
        assistantId: config.assistantId,
        idempotencyKey: record.key,
        status: 'completed',
        result: { text: 'native result preserved' },
      },
    });
  process.env[config.tokenEnv] = `cma_${'a'.repeat(43)}`;
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) delete process.env[config.tokenEnv];
    else process.env[config.tokenEnv] = originalToken;
  });
  const hooks = new Map();
  let service, path;
  const sends = [];
  plugin.register({
    pluginConfig: waConfig,
    on: (name, hook) => hooks.set(name, hook),
    registerService: (s) => (service = s),
    logger: { error: () => {} },
    runtime: {
      channel: {
        outbound: {
          loadAdapter: async (channel) => {
            assert.equal(channel, 'whatsapp');
            return {
              sendText: async (payload) => {
                sends.push(payload.text);
                return { messageId: 'TEXT02' };
              },
              sendMedia: async (payload) => {
                path = payload.mediaUrl;
                assert.equal(statSync(path).mode & 0o777, 0o600);
                assert.equal(payload.forceDocument, true);
                assert.equal(payload.to, waCtx.senderId);
                assert.ok(path.startsWith(join(stateDir, 'codeman-assistant-exports')));
                assert.equal(readFileSync(path, 'utf8'), record.parts[1].data);
                return { messageId: 'CSV02' };
              },
            };
          },
        },
      },
    },
  });
  await service.start({ stateDir, config: {} });
  t.after(() => service.stop());
  const reply = await hooks.get('reply_dispatch')(
    {
      sendPolicy: 'allow',
      ctx: {
        BodyForCommands: 'brain result',
        OriginatingChannel: 'whatsapp',
        ChatType: 'direct',
        CommandAuthorized: false,
        AccountId: waCtx.accountId,
        OriginatingTo: waCtx.conversationId,
        SenderId: waCtx.senderId,
        MessageSid: 'RESULT02',
      },
    },
    { recordProcessed: () => {}, markIdle: () => {} }
  );
  assert.equal(reply.queuedFinal, true);
  assert.deepEqual(sends, ['Preview']);
  assert.throws(() => statSync(path), /ENOENT/);
  const stored = new Outbox(join(stateDir, 'codeman-assistant-outbox.json'));
  assert.ok(stored.replyTargets.some((r) => r.messageId === 'CSV02'));
});
