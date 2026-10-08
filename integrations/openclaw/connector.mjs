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
import { dirname, isAbsolute } from 'node:path';
import { inboundMedia, mediaIdentity, stageMedia, MediaError } from './media.mjs';

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
  if (input.mediaRoot !== undefined && (typeof input.mediaRoot !== 'string' || !isAbsolute(input.mediaRoot)))
    throw new Error('mediaRoot must be an absolute local Telegram download directory');
  return { ...input, baseUrl: url.origin, allowFrom: [...input.allowFrom] };
}
export function brainRequestText(content) {
  if (typeof content !== 'string' || !/^\/?brain(?=[\s,:]|$)/i.test(content)) return undefined;
  return content.replace(/^\/?brain[,:]? */i, '');
}
export function telegramAnswer(text) {
  const banner = /^Mem0 Active \| user=[^\r\n]+ \| project=[^\r\n]+ \| branch=[^\r\n]+ \| memories=\d+\r?\n/.exec(text);
  const answer = banner ? text.slice(banner[0].length) : text;
  return answer.trim() ? answer : text;
}
function requestStatus(record) {
  const statuses = {
    queued: 'Your latest request is queued.',
    running: 'Brain is working on your latest request.',
    completed: 'Your latest request is complete.',
    cancelled: 'Your latest request was cancelled.',
    failed: 'Brain could not finish your latest request. Check Codeman before trying again.',
    interrupted: 'Your latest request was interrupted. Check Codeman before trying again.',
    outcome_unknown: 'Your latest request needs attention in Codeman. Check it before trying again.',
  };
  if (record.delivery === 'delivery_unknown')
    return 'Your answer may not have reached Telegram. Use brain result to retrieve it.';
  return statuses[record.status] ?? 'Your latest request is waiting for Brain.';
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
    this.replyTargets = [];
    if (existsSync(path)) {
      const file = JSON.parse(readFileSync(path, 'utf8'));
      if (
        file.version !== 1 ||
        !Array.isArray(file.records) ||
        file.records.length > 1000 ||
        (file.replyTargets !== undefined &&
          (!Array.isArray(file.replyTargets) ||
            file.replyTargets.length > 2000 ||
            file.replyTargets.some(
              (r) =>
                !r ||
                !uuid.test(r.assistantId) ||
                !/^[1-9][0-9]*$/.test(r.messageId ?? '') ||
                !/^[A-Za-z0-9_-]{1,100}$/.test(r.destination?.accountId ?? '') ||
                !/^[1-9][0-9]*$/.test(r.destination?.chatId ?? '') ||
                r.destination.chatId !== r.destination.senderId
            ) ||
            new Set(
              file.replyTargets.map((r) => JSON.stringify([r.destination.accountId, r.destination.chatId, r.messageId]))
            ).size !== file.replyTargets.length)) ||
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
            (r.inputHash !== undefined && !/^[a-f0-9]{64}$/.test(r.inputHash)) ||
            (r.delivery === 'pending' && (typeof r.text !== 'string' || r.payloadHash !== hash(r.text))) ||
            !['pending', 'polling', 'sending', 'delivered', 'delivery_unknown', 'stopped'].includes(r.delivery)
        ) ||
        new Set(file.records.map((r) => r.key)).size !== file.records.length
      )
        throw new Error('Connector outbox is corrupt; preserve it for reconciliation');
      this.records = file.records;
      this.replyTargets = file.replyTargets ?? [];
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
    this.persist(next, this.replyTargets);
  }
  rememberReplyTarget(target) {
    const next = structuredClone(this.replyTargets);
    const old = next.find(
      (r) =>
        r.messageId === target.messageId &&
        r.destination.accountId === target.destination.accountId &&
        r.destination.chatId === target.destination.chatId
    );
    if (old) {
      if (old.assistantId !== target.assistantId || old.destination.senderId !== target.destination.senderId)
        throw new Error('Outbound reply ownership conflict');
      return;
    }
    next.push(structuredClone(target));
    this.persist(this.records, next.slice(-2000));
  }
  persist(records, replyTargets) {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.${randomUUID()}.tmp`;
    let fd;
    try {
      fd = openSync(tmp, 'wx', 0o600);
      writeFileSync(fd, JSON.stringify({ version: 1, records, replyTargets }));
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
      this.records = records;
      this.replyTargets = replyTargets;
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
  rememberReplyTarget(destination, messageId) {
    if (!/^[1-9][0-9]*$/.test(messageId ?? '')) return;
    const { accountId, chatId, senderId } = destination;
    this.outbox.rememberReplyTarget({
      assistantId: this.config.assistantId,
      destination: { accountId, chatId, senderId },
      messageId,
    });
  }
  addressedText(event, ctx) {
    const explicit = brainRequestText(event.content);
    if (explicit !== undefined) return explicit;
    const destination = trustedDestination(event, ctx, this.config);
    const replyId = ctx.replyToMessageId;
    if (!destination || typeof replyId !== 'string' || !/^[1-9][0-9]*$/.test(replyId)) return undefined;
    const owned =
      this.outbox.records.some((r) => this.authorizedRecord(r, destination) && r.receipts.includes(replyId)) ||
      this.outbox.replyTargets.some((r) => this.authorizedRecord(r, destination) && r.messageId === replyId);
    return owned && typeof event.content === 'string' ? event.content : undefined;
  }
  async inbound(event, ctx) {
    const body = event.content ?? '';
    let text = this.addressedText(event, ctx);
    if (text === undefined) return { handled: false };
    const destination = trustedDestination(event, ctx, this.config);
    if (!destination) return { handled: true }; // Never send unauthorized text to the model or reply destination.
    let media;
    try {
      media = inboundMedia(event.mediaSource ?? event);
    } catch (error) {
      return {
        handled: true,
        reply: {
          text: error instanceof MediaError ? error.message : 'The attachment could not be read. Please send it again.',
        },
      };
    }
    const inputHash = mediaIdentity(text, media);
    const control = !media.length && /^(status|result|cancel)(?: +([a-f0-9]{64}))?$/i.exec(text);
    if (control) {
      control[1] = control[1].toLowerCase();
      control[2] ??= [...this.outbox.records].reverse().find((r) => this.authorizedRecord(r, destination))?.key;
    }
    if (control) {
      const record = control[2] && this.outbox.get(control[2]);
      if (!this.authorizedRecord(record, destination))
        return {
          handled: true,
          reply: { text: 'No matching Brain request yet. Send brain followed by what you need.' },
        };
      if (control[1] === 'cancel' && !record.requestId) {
        if (this.active.has(record.key))
          return { handled: true, reply: { text: 'Acceptance is being reconciled. Check Codeman before cancelling.' } };
        record.delivery = 'stopped';
        record.status = 'cancelled';
        delete record.text;
        this.outbox.put(record);
        return { handled: true, reply: { text: 'Cancelled before submission to Codeman.' } };
      }
      if (control[1] === 'cancel' && record.requestId) {
        try {
          await this.api(`/assistant-requests/${record.requestId}/cancel`, 'POST');
        } catch {
          return { handled: true, reply: { text: 'Cancellation unavailable. Check Codeman before retrying.' } };
        }
      }
      if (record.requestId && control[1] !== 'cancel') {
        try {
          const latest = this.request(await this.api(`/assistant-requests/${record.requestId}`), record);
          record.status = latest.status;
          if (latest.status === 'completed' && typeof latest.result?.text === 'string')
            record.parts = chunks(telegramAnswer(latest.result.text));
          this.outbox.put(record);
        } catch {
          return {
            handled: true,
            reply: { text: 'Codeman status is unavailable. Check the desktop before retrying.' },
          };
        }
      }
      if (control[1] === 'result')
        return { handled: true, reply: { text: record.parts.join('') || 'No completed result is available.' } };
      return {
        handled: true,
        reply: {
          text: requestStatus(record),
        },
      };
    }
    if (!media.length && /^(status|result|cancel)(?:\s|$)/.test(text))
      return {
        handled: true,
        reply: { text: 'Use brain status, brain result, or brain cancel for your latest request.' },
      };
    if (
      (!text && !media.length) ||
      text.length > 20000 ||
      /[\x00-\x1f\x7f]/.test(body) ||
      text.trimStart().startsWith('/')
    )
      return {
        handled: true,
        reply: { text: 'Tell Brain what you need in one line, for example: brain summarize my notes.' },
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
      if ((old.inputHash ?? old.payloadHash) !== inputHash)
        return { handled: true, reply: { text: 'Message identity conflict. Check Codeman.' } };
      return { handled: true, reply: { text: 'I already have that request.' } };
    }
    let assistant;
    // Phase 2 absence must produce an explicit unavailable reply, never terminal input.
    try {
      assistant = await this.api(`/assistants/${this.config.assistantId}`);
      if (
        assistant.id !== this.config.assistantId ||
        !assistant.enabled ||
        assistant.capabilities?.requestExecution !== true
      )
        return {
          handled: true,
          reply: {
            text:
              assistant.capabilities?.recovery?.state === 'recovering'
                ? 'Brain is reconnecting to its conversation. Please try again shortly.'
                : assistant.capabilities?.recovery?.state === 'blocked'
                  ? 'Brain needs recovery review. Open Assistants in Codeman.'
                  : 'Brain is paused. Open Assistants in Codeman and hand Brain over to messaging.',
          },
        };
    } catch {
      return { handled: true, reply: { text: 'Codeman is unavailable. No request was accepted.' } };
    }
    // Recheck after await: concurrent duplicate ingress must not replace a committed record.
    const concurrent = this.outbox.get(key);
    if (concurrent && (concurrent.inputHash ?? concurrent.payloadHash) !== inputHash)
      return { handled: true, reply: { text: 'Message identity conflict. Check Codeman.' } };
    if (this.stopped) return { handled: true, reply: { text: 'Connector is stopping. No request was accepted.' } };
    if (!concurrent) {
      try {
        text = stageMedia({
          text,
          media,
          mediaRoot: this.config.mediaRoot,
          workingDir: assistant.binding?.workingDir,
          key,
          baseUrl: this.config.baseUrl,
        });
      } catch (error) {
        return {
          handled: true,
          reply: {
            text:
              error instanceof MediaError ? error.message : 'The attachment could not be saved. No request was sent.',
          },
        };
      }
      this.outbox.put({
        key,
        assistantId: this.config.assistantId,
        destination,
        text,
        payloadHash: hash(text),
        inputHash,
        delivery: 'pending',
        parts: [],
        receipts: [],
      });
    }
    return { handled: true, reply: { text: 'On it — sending this to Brain.' } };
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
          r.parts = chunks(telegramAnswer(result.result.text));
        } else if (['failed', 'cancelled', 'interrupted', 'outcome_unknown'].includes(result.status)) {
          r.parts = [requestStatus(r)];
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
