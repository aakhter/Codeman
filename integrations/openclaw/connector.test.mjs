import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Connector, Outbox, chunks, trustedDestination, validateConfig } from './connector.mjs';
import plugin from './index.mjs';
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
  assert.match((await c.inbound(event, ctx)).reply.text, /unavailable/);
  assert.equal(c.outbox.records.length, 0);
  assert.match((await c.inbound({ ...event, content: '/brain hello\nother' }, ctx)).reply.text, /single-line/);
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
    /single-line/
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
  const hooks = new Map();
  let service;
  plugin.register({
    pluginConfig: config,
    on: (name, handler) => hooks.set(name, handler),
    registerService: (value) => {
      service = value;
    },
    runtime: { channel: { outbound: { loadAdapter: async () => ({ sendText: async () => ({ messageId: '1' }) }) } } },
    logger: { error: () => {} },
  });
  await service.start({ stateDir: h.path.slice(0, h.path.lastIndexOf('/')), config: {} });
  t.after(() => service.stop());
  const handler = hooks.get('reply_dispatch');
  const source = {
    BodyForCommands: '/brain test',
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
  assert.match(replies[0].text, /Accepted by connector/);
  assert.equal(
    JSON.parse(readFileSync(join(h.path.slice(0, h.path.lastIndexOf('/')), 'codeman-assistant-outbox.json'), 'utf8'))
      .records[0].text,
    'test'
  );
});

test('manifest explicitly activates the managed connector during gateway startup', () => {
  const manifest = JSON.parse(readFileSync(new URL('./openclaw.plugin.json', import.meta.url), 'utf8'));
  assert.equal(manifest.activation.onStartup, true);
});
