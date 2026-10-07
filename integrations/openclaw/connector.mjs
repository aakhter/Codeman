/** Transport only: no model, CLI process, terminal input, or last-response fallback. */
import { createHash, randomUUID } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  existsSync,
  openSync,
  closeSync,
  fsyncSync,
  writeFileSync,
  renameSync,
  unlinkSync,
} from 'node:fs';
import { dirname } from 'node:path';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const states = new Set([
  'queued',
  'dispatching',
  'running',
  'awaiting_approval',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
  'outcome_unknown',
]);
export function validateConfig(input) {
  const url = new URL(input.baseUrl);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/' ||
    !(
      url.protocol === 'https:' ||
      (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    )
  )
    throw new Error('Use an HTTPS or loopback Codeman origin without credentials or a path');
  if (
    !uuid.test(input.assistantId) ||
    !/^[A-Za-z0-9_-]{1,100}$/.test(input.accountId) ||
    !/^[A-Z][A-Z0-9_]*$/.test(input.tokenEnv) ||
    !Array.isArray(input.allowFrom) ||
    !input.allowFrom.length ||
    input.allowFrom.some((id) => !/^[1-9][0-9]*$/.test(id))
  )
    throw new Error('Invalid connector configuration');
  return { ...input, baseUrl: url.origin, allowFrom: [...input.allowFrom] };
}
export function trustedDestination(event, ctx, config) {
  const sender = ctx.senderId;
  const chat = typeof ctx.conversationId === 'string' ? ctx.conversationId.replace(/^telegram:/, '') : undefined;
  const messageId = ctx.messageId;
  if (
    ctx.channelId !== 'telegram' ||
    event.channel !== 'telegram' ||
    event.isGroup !== false ||
    event.commandAuthorized !== true ||
    ctx.accountId !== config.accountId ||
    !config.allowFrom.includes(sender) ||
    chat !== sender ||
    !/^[1-9][0-9]*$/.test(messageId ?? '') ||
    (event.senderId && event.senderId !== sender) ||
    (event.messageId && event.messageId !== messageId) ||
    (event.accountId && event.accountId !== ctx.accountId) ||
    (event.conversationId && event.conversationId !== ctx.conversationId) ||
    event.threadId != null
  )
    return undefined;
  return { accountId: ctx.accountId, chatId: chat, senderId: sender, messageId };
}
export function chunks(text, limit = 3500) {
  const chars = Array.from(text);
  const result = [];
  let chunk = '';
  for (const char of chars) {
    if (chunk.length + char.length > limit) {
      result.push(chunk);
      chunk = '';
    }
    chunk += char;
  }
  if (chunk) result.push(chunk);
  return result;
}

export class Outbox {
  constructor(path) {
    this.path = path;
    this.records = [];
    if (existsSync(path)) {
      const file = JSON.parse(readFileSync(path, 'utf8'));
      if (
        file.version !== 1 ||
        !Array.isArray(file.records) ||
        file.records.length > 1000 ||
        file.records.some(
          (r) =>
            !/^[a-f0-9]{64}$/.test(r.key) ||
            !uuid.test(r.assistantId) ||
            !r.destination ||
            !/^[1-9][0-9]*$/.test(r.destination.chatId) ||
            r.destination.chatId !== r.destination.senderId ||
            !Array.isArray(r.parts) ||
            !Array.isArray(r.receipts) ||
            r.parts.some((part) => typeof part !== 'string' || part.length > 3500) ||
            r.receipts.some((receipt) => typeof receipt !== 'string' || !receipt) ||
            r.receipts.length > r.parts.length ||
            !/^[A-Za-z0-9_-]{1,100}$/.test(r.destination.accountId ?? '') ||
            !/^[1-9][0-9]*$/.test(r.destination.messageId ?? '') ||
            (r.requestId !== undefined && !uuid.test(r.requestId)) ||
            (r.status !== undefined && !states.has(r.status)) ||
            !/^[a-f0-9]{64}$/.test(r.payloadHash ?? '') ||
            (r.delivery === 'pending' && (typeof r.text !== 'string' || r.payloadHash !== hash(r.text))) ||
            !['pending', 'polling', 'sending', 'delivered', 'delivery_unknown', 'stopped'].includes(r.delivery)
        ) ||
        new Set(file.records.map((r) => r.key)).size !== file.records.length
      )
        throw new Error('Connector outbox is corrupt; preserve it for reconciliation');
      this.records = file.records;
      // A crash during a platform send has an unknown recipient-visible outcome.
      for (const r of this.records) if (r.delivery === 'sending') r.delivery = 'delivery_unknown';
    }
  }
  put(record) {
    const next = structuredClone(this.records);
    const index = next.findIndex((r) => r.key === record.key);
    if (index < 0) {
      if (next.length >= 1000) throw new Error('Outbox is full; archive reconciled records before continuing');
      next.push(record);
    } else next[index] = record;
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.${randomUUID()}.tmp`;
    let fd;
    try {
      fd = openSync(tmp, 'wx', 0o600);
      writeFileSync(fd, JSON.stringify({ version: 1, records: next }));
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(tmp, this.path);
      const dir = openSync(dirname(this.path), 'r');
      try {
        fsyncSync(dir);
      } finally {
        closeSync(dir);
      }
      this.records = next;
    } finally {
      if (fd !== undefined) closeSync(fd);
      if (existsSync(tmp)) unlinkSync(tmp);
    }
  }
  get(key) {
    return structuredClone(this.records.find((r) => r.key === key));
  }
}

class ContractViolation extends Error {}

export class Connector {
  constructor({ config, outbox, token, fetchImpl = fetch, deliver }) {
    this.config = validateConfig(config);
    this.outbox = outbox;
    this.token = token;
    this.fetch = fetchImpl;
    this.deliver = deliver;
    this.active = new Set();
    this.stopped = false;
  }
  async api(path, method = 'GET', body) {
    const token = this.token();
    if (!/^cma_[A-Za-z0-9_-]{43}$/.test(token ?? '')) throw new Error('Connector credential is unavailable');
    const response = await this.fetch(`${this.config.baseUrl}/api/v1${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error(`Codeman request unavailable (${response.status})`);
    const value = await response.json();
    if (value.success !== true || !value.data) throw new Error('Unsupported Codeman response');
    return value.data;
  }
  request(value, record) {
    if (
      !uuid.test(value.id) ||
      value.assistantId !== record.assistantId ||
      value.idempotencyKey !== record.key ||
      !states.has(value.status) ||
      (record.requestId && value.id !== record.requestId)
    )
      throw new ContractViolation('Request identity mismatch');
    return value;
  }
  authorizedRecord(record, destination) {
    return (
      record &&
      record.assistantId === this.config.assistantId &&
      record.destination.accountId === destination.accountId &&
      record.destination.chatId === destination.chatId &&
      record.destination.senderId === destination.senderId
    );
  }
  async inbound(event, ctx) {
    const body = event.content ?? '';
    if (typeof body !== 'string' || !/^\/brain(?:\s|$)/.test(body)) return { handled: false };
    const destination = trustedDestination(event, ctx, this.config);
    if (!destination) return { handled: true }; // Never send unauthorized text to the model or reply destination.
    const text = body.replace(/^\/brain */, '');
    const control = /^(status|result|cancel)\s+([a-f0-9]{64})$/.exec(text);
    if (control) {
      const record = this.outbox.get(control[2]);
      if (!this.authorizedRecord(record, destination)) return { handled: true, reply: { text: 'Request not found.' } };
      if (control[1] === 'cancel' && record.requestId) {
        try {
          await this.api(`/assistant-requests/${record.requestId}/cancel`, 'POST');
        } catch {
          return { handled: true, reply: { text: 'Cancellation unavailable. Check Codeman before retrying.' } };
        }
      }
      if (control[1] === 'result')
        return { handled: true, reply: { text: record.parts.join('') || 'No completed result is available.' } };
      return {
        handled: true,
        reply: {
          text: `${record.status ?? record.delivery}; delivery: ${record.delivery}. Approvals and interruptions require Codeman.`,
        },
      };
    }
    if (/^(status|result|cancel)(?:\s|$)/.test(text))
      return {
        handled: true,
        reply: { text: 'Use /brain status|result|cancel followed by the connector request key.' },
      };
    if (!text || text.length > 20000 || /[\x00-\x1f\x7f]/.test(body) || text.trimStart().startsWith('/'))
      return {
        handled: true,
        reply: { text: 'Use /brain followed by a single-line request without terminal controls or CLI commands.' },
      };
    const key = hash(
      JSON.stringify([
        'telegram',
        destination.accountId,
        destination.chatId,
        destination.senderId,
        destination.messageId,
        this.config.assistantId,
      ])
    );
    const old = this.outbox.get(key);
    if (old) {
      if (old.payloadHash !== hash(text))
        return { handled: true, reply: { text: 'Message identity conflict. Check Codeman.' } };
      return { handled: true, reply: { text: `Existing request ${key}; ${old.status ?? old.delivery}.` } };
    }
    // Phase 2 absence must produce an explicit unavailable reply, never terminal input.
    try {
      const assistant = await this.api(`/assistants/${this.config.assistantId}`);
      if (
        assistant.id !== this.config.assistantId ||
        !assistant.enabled ||
        assistant.capabilities?.requestExecution !== true
      )
        return {
          handled: true,
          reply: {
            text: 'Brain execution is unavailable. Codeman needs the durable request engine and desktop handoff.',
          },
        };
    } catch {
      return { handled: true, reply: { text: 'Codeman is unavailable. No request was accepted.' } };
    }
    // Recheck after await: concurrent duplicate ingress must not replace a committed record.
    const concurrent = this.outbox.get(key);
    if (concurrent && concurrent.payloadHash !== hash(text))
      return { handled: true, reply: { text: 'Message identity conflict. Check Codeman.' } };
    if (this.stopped) return { handled: true, reply: { text: 'Connector is stopping. No request was accepted.' } };
    if (!concurrent)
      this.outbox.put({
        key,
        assistantId: this.config.assistantId,
        destination,
        text,
        payloadHash: hash(text),
        delivery: 'pending',
        parts: [],
        receipts: [],
      });
    return { handled: true, reply: { text: `Accepted by connector: ${key}. Use /brain status ${key}.` } };
  }
  async tick() {
    if (this.stopped) return;
    for (const snapshot of [...this.outbox.records]) {
      if (this.stopped) break;
      if (this.active.has(snapshot.key) || !['pending', 'polling'].includes(snapshot.delivery)) continue;
      const r = this.outbox.get(snapshot.key);
      if (
        r.assistantId !== this.config.assistantId ||
        r.destination.accountId !== this.config.accountId ||
        !this.config.allowFrom.includes(r.destination.senderId)
      )
        continue;
      this.active.add(r.key);
      try {
        if (!r.requestId) {
          const result = this.request(
            await this.api(`/assistants/${r.assistantId}/requests`, 'POST', { text: r.text, idempotencyKey: r.key }),
            r
          );
          r.requestId = result.id;
          r.status = result.status;
          r.delivery = 'polling';
          this.outbox.put(r);
        }
        if (this.stopped) continue;
        const result = this.request(await this.api(`/assistant-requests/${r.requestId}`), r);
        r.status = result.status;
        if (result.status === 'completed') {
          if (typeof result.result?.text !== 'string' || !result.result.text || result.result.text.length > 1000000)
            throw new ContractViolation('Unsupported completed result');
          r.parts = chunks(result.result.text);
        } else if (['failed', 'cancelled', 'interrupted', 'outcome_unknown'].includes(result.status)) {
          r.parts = [`Brain request ${r.key}: ${result.status}. Check Codeman before sending another request.`];
        }
        this.outbox.put(r);
        if (!r.parts.length || this.stopped) continue;
        for (let index = r.receipts.length; index < r.parts.length; index++) {
          if (this.stopped) break;
          r.delivery = 'sending';
          this.outbox.put(r);
          try {
            const receipt = await this.deliver(r.destination, r.parts[index]);
            if (!receipt?.messageId) throw new Error('Missing delivery receipt');
            r.receipts.push(String(receipt.messageId));
            r.delivery = 'polling';
            this.outbox.put(r);
          } catch {
            r.delivery = 'delivery_unknown';
            this.outbox.put(r);
            break;
          }
        }
        if (r.receipts.length === r.parts.length) {
          r.delivery = 'delivered';
          delete r.text;
          this.outbox.put(r);
        }
      } catch (error) {
        if (error instanceof ContractViolation) {
          r.delivery = 'stopped';
          r.status = 'outcome_unknown';
          this.outbox.put(r);
        }
        /* Poll/submit retry uses the same persisted key; never log content or credentials. */
      } finally {
        this.active.delete(r.key);
      }
    }
  }
}
