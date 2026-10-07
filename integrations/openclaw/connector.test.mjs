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
