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
import { whatsappParts, validAnswerPart } from './whatsapp-format.mjs';
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
const DELIVERY_RETRY_DELAYS = [5000, 15000, 30000, 60000, 120000];
export function deliveryRetryDelay(error, failures) {
  if (!Number.isInteger(failures) || failures < 1 || failures > DELIVERY_RETRY_DELAYS.length) return undefined;
  const notDispatched = error?.code === 'OPENCLAW_PLATFORM_MESSAGE_NOT_DISPATCHED';
  if (notDispatched && error.retryable === false) return undefined;
  const code = Number(
    error?.error_code ??
      error?.response?.error_code ??
      error?.error?.status ??
      error?.status ??
      error?.statusCode ??
      error?.output?.statusCode
  );
  const network =
    /Network request for ['"]sendMessage['"] failed|fetch failed|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|connection closed|connection lost|timed out/i.test(
      String(error?.message ?? '')
    );
  if (code >= 400 && code < 500 && code !== 429) return undefined;
  if (code !== 429 && !(code >= 500 && code <= 599) && !network && !notDispatched) return undefined;
  const retryAfter = Number(error?.parameters?.retry_after ?? error?.response?.parameters?.retry_after);
  return Math.max(
    DELIVERY_RETRY_DELAYS[failures - 1],
    Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 86400) * 1000 : 0
  );
}
export const telegramDeliveryRetryDelay = deliveryRetryDelay; // Preserve existing import compatibility.

// Missing channel on saved records is the pre-WhatsApp Telegram format.
const channelOf = (destination) => destination?.channel ?? 'telegram';
const phone = /^\+[1-9][0-9]{6,14}$/;
const account = /^[A-Za-z0-9_-]{1,100}$/;
function validMessageId(channel, id) {
  return (
    typeof id === 'string' &&
    (channel === 'telegram' ? /^[1-9][0-9]*$/.test(id) : channel === 'whatsapp' && /^[A-Za-z0-9_-]{1,128}$/.test(id))
  );
}
function validDestination(d, message = false) {
  const channel = channelOf(d);
  return (
    d &&
    account.test(d.accountId ?? '') &&
    d.chatId === d.senderId &&
    (channel === 'telegram'
      ? /^[1-9][0-9]*$/.test(d.chatId ?? '')
      : channel === 'whatsapp' && phone.test(d.chatId ?? '')) &&
    (!message || validMessageId(channel, d.messageId))
  );
}
function channelConfig(config, channel) {
  return channel === 'telegram' ? config : channel === 'whatsapp' ? config.whatsapp : undefined;
}
export function validateConfig(input) {
  if (input.contextRouting !== undefined && typeof input.contextRouting !== 'boolean')
    throw new Error('contextRouting must be boolean');
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
    throw new Error('mediaRoot must be an absolute local download directory');
  if (
    input.whatsapp !== undefined &&
    (!input.whatsapp ||
      !account.test(input.whatsapp.accountId ?? '') ||
      !Array.isArray(input.whatsapp.allowFrom) ||
      !input.whatsapp.allowFrom.length ||
      input.whatsapp.allowFrom.some((id) => typeof id !== 'string' || !phone.test(id)) ||
      (input.whatsapp.mediaRoot !== undefined &&
        (typeof input.whatsapp.mediaRoot !== 'string' || !isAbsolute(input.whatsapp.mediaRoot))))
  )
    throw new Error('Invalid WhatsApp connector configuration');
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
function answerParts(text, destination) {
  const answer = telegramAnswer(text);
  return channelOf(destination) === 'whatsapp' ? whatsappParts(answer) : chunks(answer);
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
  if (record.delivery === 'retrying') return 'Reply delivery is being retried automatically.';
  if (record.delivery === 'delivery_unknown')
    return 'Your answer may not have reached this chat. Use brain result to retrieve it.';
  return statuses[record.status] ?? 'Your latest request is waiting for Brain.';
}
export function trustedDestination(event, ctx, config) {
  const channel = ctx.channelId;
  const policy = channelConfig(config, channel);
  const sender = ctx.senderId;
  const chat =
    typeof ctx.conversationId === 'string'
      ? ctx.conversationId.startsWith(`${channel}:`)
        ? ctx.conversationId.slice(channel.length + 1)
        : ctx.conversationId
      : undefined;
  const destination = { accountId: ctx.accountId, chatId: chat, senderId: sender, messageId: ctx.messageId };
  if (channel === 'whatsapp') destination.channel = channel;
  // WhatsApp normal messages have CommandAuthorized=false when command access
  // was not checked. Exact private-chat/account/phone allowlisting authorizes
  // these requests; explicitly denied slash commands remain rejected.
  if (
    !policy ||
    event.channel !== channel ||
    event.isGroup !== false ||
    (channel === 'telegram' && event.commandAuthorized !== true) ||
    (channel === 'whatsapp' && event.content?.startsWith('/') && event.commandAuthorized !== true) ||
    ctx.accountId !== policy.accountId ||
    !policy.allowFrom.includes(sender) ||
    !validDestination(destination, true) ||
    (event.senderId && event.senderId !== sender) ||
    (event.messageId && event.messageId !== ctx.messageId) ||
    (event.accountId && event.accountId !== ctx.accountId) ||
    (event.conversationId && event.conversationId !== ctx.conversationId) ||
    event.threadId != null
  )
    return undefined;
  return destination;
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

const questionKey = (q) => hash(JSON.stringify([q.threadId, q.turnId, q.itemId]));
function validQuestion(q) {
  return (
    q &&
    typeof q.key === 'string' &&
    q.key.length <= 500 &&
    Array.isArray(q.parts) &&
    q.parts.length <= 50 &&
    q.parts.every((p) => typeof p === 'string' && p.length <= 3500) &&
    Array.isArray(q.receipts) &&
    q.receipts.length <= q.parts.length &&
    q.receipts.every((p) => typeof p === 'string' && p.length <= 128) &&
    ['pending', 'sending', 'delivered', 'delivery_unknown', 'resolved'].includes(q.delivery) &&
    (q.retryAt === undefined || Number.isSafeInteger(q.retryAt)) &&
    (q.failures === undefined || (Number.isInteger(q.failures) && q.failures >= 0 && q.failures <= 6))
  );
}
function questionParts(input) {
  if (
    !input ||
    [input.threadId, input.turnId, input.itemId].some((v) => typeof v !== 'string' || !v || v.length > 200) ||
    !['string', 'number'].includes(typeof input.requestId) ||
    !Array.isArray(input.questions) ||
    !input.questions.length ||
    input.questions.length > 10 ||
    input.questions.some(
      (q) =>
        !q ||
        q.isSecret ||
        typeof q.id !== 'string' ||
        typeof q.question !== 'string' ||
        q.question.length > 10000 ||
        (q.options != null && !Array.isArray(q.options))
    )
  )
    throw new ContractViolation('Unsupported native question');
  const text = input.questions
    .map((q, index) => {
      const options = (q.options ?? [])
        .map((o, i) => `${i + 1}. ${o.label}${o.description ? ` — ${o.description}` : ''}`)
        .join('\n');
      return `${input.questions.length > 1 ? `${index + 1}) ` : ''}${q.question}${options ? `\n${options}` : ''}`;
    })
    .join('\n\n');
  return chunks(
    `Brain has a question:\n\n${text}\n\nReply to this message with your answer${input.questions.length > 1 ? ', one line per question' : ''}. You can also send brain answer followed by your answer.`
  );
}
function nativeAnswers(input, text) {
  const lines =
    input.questions.length === 1
      ? [text.trim()]
      : text
          .split(/\r?\n/)
          .map((t) => t.trim())
          .filter(Boolean);
  if (lines.length !== input.questions.length || lines.some((t) => !t || t.length > 20000)) return undefined;
  const answers = {};
  for (const [i, q] of input.questions.entries()) {
    let answer = lines[i];
    const options = q.options ?? [];
    if (options.length) {
      const number = /^[1-9][0-9]*$/.test(answer) ? Number(answer) : undefined;
      const option = number ? options[number - 1] : options.find((o) => o.label.toLowerCase() === answer.toLowerCase());
      if (option) answer = option.label;
      else if (!q.isOther) return undefined;
    }
    answers[q.id] = { answers: [answer] };
  }
  return answers;
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
                !validMessageId(channelOf(r.destination), r.messageId) ||
                !validDestination(r.destination)
            ) ||
            new Set(
              file.replyTargets.map((r) =>
                JSON.stringify([channelOf(r.destination), r.destination.accountId, r.destination.chatId, r.messageId])
              )
            ).size !== file.replyTargets.length)) ||
        file.records.some(
          (r) =>
            !/^[a-f0-9]{64}$/.test(r.key) ||
            !uuid.test(r.assistantId) ||
            !validDestination(r.destination, true) ||
            !Array.isArray(r.parts) ||
            !Array.isArray(r.receipts) ||
            r.parts.some(
              (part) => !validAnswerPart(part) || (typeof part !== 'string' && channelOf(r.destination) !== 'whatsapp')
            ) ||
            r.receipts.some((receipt) => typeof receipt !== 'string' || !receipt) ||
            r.receipts.length > r.parts.length ||
            (r.questions !== undefined &&
              (!Array.isArray(r.questions) ||
                r.questions.length > 100 ||
                r.questions.some((q) => !validQuestion(q)))) ||
            (r.requestId !== undefined && !uuid.test(r.requestId)) ||
            (r.status !== undefined && !states.has(r.status)) ||
            !/^[a-f0-9]{64}$/.test(r.payloadHash ?? '') ||
            (r.inputHash !== undefined && !/^[a-f0-9]{64}$/.test(r.inputHash)) ||
            (r.delivery === 'pending' && (typeof r.text !== 'string' || r.payloadHash !== hash(r.text))) ||
            (r.deliveryFailures !== undefined &&
              (!Number.isInteger(r.deliveryFailures) || r.deliveryFailures < 0 || r.deliveryFailures > 6)) ||
            (r.retryAt !== undefined && (!Number.isSafeInteger(r.retryAt) || r.retryAt < 0)) ||
            (r.delivery === 'retrying' &&
              (!r.requestId ||
                !r.deliveryFailures ||
                r.deliveryFailures > 5 ||
                r.retryAt === undefined ||
                r.parts.length <= r.receipts.length)) ||
            !['pending', 'polling', 'sending', 'delivered', 'delivery_unknown', 'stopped', 'retrying'].includes(
              r.delivery
            )
        ) ||
        new Set(file.records.map((r) => r.key)).size !== file.records.length
      )
        throw new Error('Connector outbox is corrupt; preserve it for reconciliation');
      this.records = file.records;
      this.replyTargets = file.replyTargets ?? [];
      // A crash during a platform send has an unknown recipient-visible outcome.
      for (const r of this.records) {
        if (r.delivery === 'sending') r.delivery = 'delivery_unknown';
        for (const q of r.questions ?? []) if (q.delivery === 'sending') q.delivery = 'delivery_unknown';
      }
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
        channelOf(r.destination) === channelOf(target.destination) &&
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
  constructor({ config, outbox, token, fetchImpl = fetch, deliver, now = Date.now, routing }) {
    this.config = validateConfig(config);
    this.routing = routing;
    this.outbox = outbox;
    this.token = token;
    this.fetch = fetchImpl;
    this.deliver = deliver;
    this.now = now;
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
      channelOf(record.destination) === channelOf(destination) &&
      record.destination.accountId === destination.accountId &&
      record.destination.chatId === destination.chatId &&
      record.destination.senderId === destination.senderId
    );
  }
  rememberReplyTarget(destination, messageId) {
    if (!validMessageId(channelOf(destination), messageId)) return;
    const { accountId, chatId, senderId } = destination;
    this.outbox.rememberReplyTarget({
      assistantId: this.config.assistantId,
      destination: { accountId, chatId, senderId, ...(destination.channel ? { channel: destination.channel } : {}) },
      messageId,
    });
  }
  addressedText(event, ctx) {
    const explicit = brainRequestText(event.content);
    if (explicit !== undefined) return explicit;
    const destination = trustedDestination(event, ctx, this.config);
    const replyId = ctx.replyToMessageId;
    if (!destination || !validMessageId(channelOf(destination), replyId)) return undefined;
    const owned =
      this.outbox.records.some(
        (r) =>
          this.authorizedRecord(r, destination) &&
          (r.receipts.includes(replyId) || r.questions?.some((q) => q.receipts.includes(replyId)))
      ) || this.outbox.replyTargets.some((r) => this.authorizedRecord(r, destination) && r.messageId === replyId);
    return owned && typeof event.content === 'string' ? event.content : undefined;
  }
  async answerQuestion(destination, replyId, text, explicit) {
    const records = this.outbox.records.filter((r) => this.authorizedRecord(r, destination));
    let matches = records.flatMap((r) =>
      (r.questions ?? [])
        .filter((q) => (replyId ? q.receipts.includes(replyId) : q.delivery === 'delivered'))
        .map((q) => ({ r, q }))
    );
    if (!replyId) {
      const live = [];
      for (const match of matches) {
        const current = this.request(await this.api(`/assistant-requests/${match.r.requestId}`), match.r);
        if (current.pendingInput && questionKey(current.pendingInput) === match.q.key) live.push({ ...match, current });
      }
      matches = live;
    }
    if (!matches.length)
      return explicit
        ? { handled: true, reply: { text: 'No pending question is available. Check Brain in Codeman.' } }
        : undefined;
    if (matches.length !== 1)
      return { handled: true, reply: { text: 'Please reply directly to the question you want to answer.' } };
    const { r, q } = matches[0];
    const current = matches[0].current ?? this.request(await this.api(`/assistant-requests/${r.requestId}`), r);
    const key = hash(
      JSON.stringify([
        channelOf(destination),
        destination.accountId,
        destination.chatId,
        destination.messageId,
        r.requestId,
        q.key,
      ])
    );
    const previous = current.inputAnswers?.find((a) => a.idempotencyKey === key);
    if (previous?.state === 'answered')
      return { handled: true, reply: { text: 'Your answer has already reached Brain.' } };
    if (!current.pendingInput || questionKey(current.pendingInput) !== q.key)
      return {
        handled: true,
        reply: { text: 'That question has already been resolved. Check the latest reply from Brain.' },
      };
    const answers = nativeAnswers(current.pendingInput, text);
    if (!answers)
      return {
        handled: true,
        reply: {
          text: 'Please use a listed option number or label. For several questions, answer each on its own line.',
        },
      };
    await this.api(`/assistant-requests/${r.requestId}/answer`, 'POST', {
      questionKey: q.key,
      answers,
      idempotencyKey: key,
    });
    q.delivery = 'resolved';
    this.outbox.put(r);
    return { handled: true, reply: { text: 'Thanks — your answer has reached Brain.' } };
  }
  async deliverQuestion(r, input) {
    const key = questionKey(input);
    r.questions ??= [];
    let q = r.questions.find((q) => q.key === key);
    if (!q) {
      if (r.questions.length >= 100) throw new ContractViolation('Too many questions');
      q = { key, parts: questionParts(input), receipts: [], delivery: 'pending' };
      r.questions.push(q);
      this.outbox.put(r);
    }
    if (q.delivery !== 'pending' || (q.retryAt ?? 0) > this.now()) return;
    for (let index = q.receipts.length; index < q.parts.length; index++) {
      q.delivery = 'sending';
      this.outbox.put(r);
      try {
        const receipt = await this.deliver(r.destination, q.parts[index]);
        if (!validMessageId(channelOf(r.destination), String(receipt?.messageId)))
          throw new Error('Missing question receipt');
        q.receipts.push(String(receipt.messageId));
        this.routing?.delivered(r.destination, r.key, q.parts.join('\n\n'), String(receipt.messageId), true);
        q.delivery = 'pending';
        delete q.failures;
        delete q.retryAt;
        this.outbox.put(r);
      } catch (e) {
        q.failures = Math.min((q.failures ?? 0) + 1, 6);
        const delay = deliveryRetryDelay(e, q.failures);
        q.delivery = delay === undefined ? 'delivery_unknown' : 'pending';
        if (delay !== undefined) q.retryAt = this.now() + delay;
        this.outbox.put(r);
        return;
      }
    }
    q.delivery = 'delivered';
    this.outbox.put(r);
  }
  async inbound(event, ctx) {
    const body = event.content ?? '';
    let text = ctx.contextRouted ? event.content : this.addressedText(event, ctx);
    if (text === undefined) return { handled: false };
    const destination = trustedDestination(event, ctx, this.config);
    if (!destination) return { handled: true }; // Never send unauthorized text to the model or reply destination.
    const explicitAnswer = /^answer(?:\s|$)/i.test(text);
    const quotedQuestion = this.outbox.records.some(
      (r) =>
        this.authorizedRecord(r, destination) && r.questions?.some((q) => q.receipts.includes(ctx.replyToMessageId))
    );
    const explicitControl =
      brainRequestText(body) !== undefined && /^(status|result|cancel)(?: +[a-f0-9]{64})?$/i.test(text);
    if (explicitAnswer || (quotedQuestion && !explicitControl)) {
      try {
        if (inboundMedia(event.mediaSource ?? event).length)
          return {
            handled: true,
            reply: { text: 'Please answer this question with text. Attachments can be sent with a new Brain request.' },
          };
        return (
          (await this.answerQuestion(
            destination,
            quotedQuestion ? ctx.replyToMessageId : undefined,
            explicitAnswer ? text.replace(/^answer\s*/i, '') : text,
            explicitAnswer
          )) ?? { handled: true }
        );
      } catch {
        return {
          handled: true,
          reply: { text: 'Your answer could not be confirmed. Check Brain in Codeman before trying again.' },
        };
      }
    }
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
    const originalText = text;
    const inputHash = mediaIdentity(text, media);
    const control =
      !ctx.semanticContinuation && !media.length && /^(status|result|cancel)(?: +([a-f0-9]{64}))?$/i.exec(text);
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
          const previousStatus = record.status;
          record.status = latest.status;
          if (
            latest.status === 'completed' &&
            typeof latest.result?.text === 'string' &&
            (!record.parts.length || previousStatus !== 'completed')
          )
            record.parts = answerParts(latest.result.text, record.destination);
          this.outbox.put(record);
        } catch {
          return {
            handled: true,
            reply: { text: 'Codeman status is unavailable. Check the desktop before retrying.' },
          };
        }
      }
      if (control[1] === 'result')
        return {
          handled: true,
          reply: {
            text:
              record.parts
                .filter((p) => typeof p === 'string')
                .join(channelOf(destination) === 'whatsapp' ? '\n\n' : '') || 'No completed result is available.',
            ...(channelOf(destination) === 'whatsapp' && record.parts.length ? { parts: record.parts } : {}),
          },
        };
      return {
        handled: true,
        reply: {
          text: requestStatus(record),
        },
      };
    }
    if (!ctx.semanticContinuation && !media.length && /^(status|result|cancel)(?:\s|$)/.test(text))
      return {
        handled: true,
        reply: { text: 'Use brain status, brain result, or brain cancel for your latest request.' },
      };
    if (
      (!text.trim() && !media.length) ||
      text.length > 20000 ||
      /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(body) ||
      text.trimStart().startsWith('/')
    )
      return {
        handled: true,
        reply: {
          text: 'Tell Brain what you need, for example: brain summarize my notes. Avoid terminal controls and CLI slash commands.',
        },
      };
    const key = hash(
      JSON.stringify([
        channelOf(destination),
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
          mediaRoot: channelConfig(this.config, channelOf(destination))?.mediaRoot,
          workingDir: assistant.binding?.workingDir,
          key,
          baseUrl: this.config.baseUrl,
          conversationContext: ctx.routingContext,
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
    this.routing?.accepted(destination, originalText, key);
    return { handled: true, reply: { text: 'On it — sending this to Brain.' } };
  }
  async tick() {
    if (this.stopped) return;
    for (const snapshot of [...this.outbox.records]) {
      if (this.stopped) break;
      if (
        this.active.has(snapshot.key) ||
        !['pending', 'polling', 'retrying'].includes(snapshot.delivery) ||
        (snapshot.retryAt ?? 0) > this.now()
      )
        continue;
      const r = this.outbox.get(snapshot.key);
      const policy = channelConfig(this.config, channelOf(r.destination));
      if (
        !policy ||
        r.assistantId !== this.config.assistantId ||
        r.destination.accountId !== policy.accountId ||
        !policy.allowFrom.includes(r.destination.senderId)
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
        if (result.pendingInput && ['dispatching', 'running', 'awaiting_approval'].includes(result.status))
          await this.deliverQuestion(r, result.pendingInput);
        if (result.status === 'completed') {
          if (typeof result.result?.text !== 'string' || !result.result.text || result.result.text.length > 1000000)
            throw new ContractViolation('Unsupported completed result');
          if (!r.parts.length) r.parts = answerParts(result.result.text, r.destination);
        } else if (['failed', 'cancelled', 'interrupted', 'outcome_unknown'].includes(result.status)) {
          r.parts = [requestStatus({ ...r, delivery: 'polling' })];
        }
        this.outbox.put(r);
        if (!r.parts.length || this.stopped) continue;
        for (let index = r.receipts.length; index < r.parts.length; index++) {
          if (this.stopped) break;
          r.delivery = 'sending';
          delete r.retryAt;
          this.outbox.put(r);
          try {
            const receipt = await this.deliver(r.destination, r.parts[index]);
            if (!receipt?.messageId) throw new Error('Missing delivery receipt');
            r.receipts.push(String(receipt.messageId));
            if (r.status === 'completed')
              this.routing?.delivered(
                r.destination,
                r.key,
                r.parts.filter((p) => typeof p === 'string').join('\n\n'),
                String(receipt.messageId)
              );
            r.delivery = 'polling';
            delete r.deliveryFailures;
            this.outbox.put(r);
          } catch (error) {
            r.deliveryFailures = Math.min((r.deliveryFailures ?? 0) + 1, 6);
            const delay = deliveryRetryDelay(error, r.deliveryFailures);
            r.delivery = delay === undefined ? 'delivery_unknown' : 'retrying';
            if (delay !== undefined) r.retryAt = this.now() + delay;
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
