import { join } from 'node:path';
import { mkdirSync, mkdtempSync, lstatSync, writeFileSync, rmSync } from 'node:fs';
import { ConversationRouter, ROUTING_PROMPT } from './conversation-routing.mjs';
import { validAnswerPart } from './whatsapp-format.mjs';
import { Connector, Outbox, brainRequestText, trustedDestination, validateConfig } from './connector.mjs';

export async function classifyConversation(runtime, facts, timeoutMs = 6000) {
  if (!runtime.llm?.complete) throw new Error('Routing classifier unavailable');
  let timer;
  const controller = new AbortController();
  try {
    const result = await Promise.race([
      runtime.llm.complete({
        messages: [{ role: 'user', content: JSON.stringify(facts) }],
        systemPrompt: ROUTING_PROMPT,
        maxTokens: 800,
        temperature: 0,
        reasoning: 'low',
        purpose: 'codeman-assistant-conversation-routing',
        signal: controller.signal,
        responseFormat: { type: 'json_object' },
      }),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error('Routing deadline'));
        }, timeoutMs);
      }),
    ]);
    if (typeof result.text !== 'string' || result.text.length > 1000) throw new Error('Unsupported routing response');
    return JSON.parse(result.text);
  } finally {
    clearTimeout(timer);
  }
}

export default {
  id: 'codeman-assistant',
  name: 'Codeman Assistant',
  register(api) {
    const config = validateConfig(api.pluginConfig ?? {});
    let connector;
    let router;
    let timer;
    let running;
    let deliver;
    const dispatches = new Set();
    const inbound = async (event, ctx) => {
      if (!connector) {
        return brainRequestText(event.content) !== undefined
          ? { handled: true, reply: { text: 'Codeman connector is starting or unavailable.' } }
          : { handled: false };
      }
      return connector.inbound(event, ctx);
    };
    // inbound_claim only runs for plugin-owned conversation bindings. Ordinary
    // Telegram chats need reply_dispatch, which also retains CommandAuthorized,
    // stable message IDs and thread metadata that before_dispatch omits.
    api.on('inbound_claim', inbound);
    const dispatch = async (event, ctx) => {
      const source = event.ctx ?? {};
      const content = source.BodyForCommands ?? source.RawBody ?? '';
      const channel = source.OriginatingChannel ?? source.Surface ?? source.Provider;
      if (!['telegram', 'whatsapp'].includes(channel)) return { handled: false };
      const counts = { tool: 0, block: 0, final: 0 };
      const message = {
        content,
        mediaSource: source,
        channel,
        isGroup: source.ChatType === 'direct' ? false : true,
        commandAuthorized: source.CommandAuthorized,
        threadId: source.MessageThreadId,
        runId: event.runId,
        sessionKey: event.sessionKey,
      };
      const identity = {
        channelId: channel,
        accountId: source.AccountId,
        conversationId: source.OriginatingTo ?? source.To,
        senderId: source.SenderId,
        messageId: source.MessageSidFull ?? source.MessageSid,
        replyToMessageId: source.ReplyToIdFull ?? source.ReplyToId,
      };
      const addressed = connector ? connector.addressedText(message, identity) : brainRequestText(content);
      if (
        event.isTailDispatch ||
        source.InternalTurnSource != null ||
        event.sendPolicy !== 'allow' ||
        (event.suppressUserDelivery && event.sourceReplyDeliveryMode !== 'message_tool_only')
      )
        return { handled: addressed !== undefined, queuedFinal: false, counts };
      const destination = trustedDestination(message, identity, config);
      if (!destination) return { handled: addressed !== undefined, queuedFinal: false, counts };
      let routedMessage = message;
      let routedIdentity = identity;
      let decision;
      if (router) {
        try {
          const pendingQuestions = connector.outbox.records
            .filter(
              (r) =>
                connector.authorizedRecord(r, destination) &&
                ['dispatching', 'running', 'awaiting_approval'].includes(r.status)
            )
            .flatMap((r) =>
              (r.questions ?? [])
                .filter((q) => q.delivery === 'delivered')
                .map((q) => ({
                  parentId: r.key,
                  receipt: q.receipts[0],
                  text: q.parts.join('\n\n'),
                }))
            );
          decision = await router.decide(
            message,
            { ...destination, replyToMessageId: identity.replyToMessageId },
            {
              explicit:
                brainRequestText(content) !== undefined ||
                connector.outbox.records.some(
                  (r) => connector.authorizedRecord(r, destination) && r.destination.messageId === destination.messageId
                ),
              quoted: addressed !== undefined && brainRequestText(content) === undefined,
              pendingQuestions,
              quoteParent:
                connector.outbox.records.find(
                  (r) =>
                    connector.authorizedRecord(r, destination) &&
                    (r.receipts.includes(identity.replyToMessageId) ||
                      r.questions?.some((q) => q.receipts.includes(identity.replyToMessageId)))
                )?.key ?? null,
            }
          );
          if (decision.route === 'openclaw') {
            if (decision.original) {
              // The SDK passes this canonical ctx by reference to the default dispatch path.
              // Forward the user's original text/media, not the bare clarification selection.
              source.BodyForCommands = decision.original.event.content;
              source.BodyForAgent = decision.original.event.content;
              source.RawBody = decision.original.event.content;
              source.media = decision.original.event.mediaSource.media;
              source.MediaPaths = source.media.map((m) => m.path);
              source.MediaTypes = source.media.map((m) => m.contentType);
            }
            return { handled: false };
          }
          if (decision.original && decision.route === 'brain') {
            routedMessage = decision.original.event;
            const d = decision.original.destination;
            routedIdentity = {
              channelId: d.channel ?? 'telegram',
              accountId: d.accountId,
              conversationId: d.chatId,
              senderId: d.senderId,
              messageId: d.messageId,
            };
          }
          routedIdentity = {
            ...routedIdentity,
            contextRouted: brainRequestText(routedMessage.content) === undefined,
            ...(decision.questionReceipt ? { replyToMessageId: decision.questionReceipt } : {}),
            routingContext: decision.context,
            semanticContinuation: decision.semantic === true,
          };
        } catch {
          decision = { route: 'clarify', unavailable: true };
        }
      } else if (addressed === undefined) return { handled: false };
      const result =
        decision?.route === 'clarify'
          ? {
              handled: true,
              reply: {
                text: decision.conflict
                  ? 'Message identity conflict. Check Codeman.'
                  : decision.unavailable
                    ? 'Conversation routing is unavailable. Please address Brain explicitly or start a new OpenClaw topic.'
                    : 'Continue with Brain, or start a new topic with OpenClaw? Reply “Brain” or “OpenClaw”.',
              },
            }
          : await inbound(routedMessage, routedIdentity);
      if (!result.handled) return { handled: false };
      let queuedFinal = false;
      if (result.reply) {
        // Use the receipt-bearing trusted adapter for every connector reply,
        // including acknowledgements/status. Reply ownership survives restart.
        try {
          for (const part of result.reply.parts ?? [result.reply.text]) {
            const receipt = await deliver(destination, part);
            if (decision?.route === 'clarify') router?.clarified(destination, String(receipt?.messageId ?? ''));
            else if (decision?.route === 'brain') router?.acknowledged(destination, String(receipt?.messageId ?? ''));
          }
          queuedFinal = true;
        } catch {
          // The request may already be accepted. Never fall back to the model
          // or replay it because the acknowledgement could not be delivered.
          api.logger?.error?.('Codeman connector acknowledgement delivery needs attention');
        }
        if (queuedFinal) counts.final = 1;
      }
      ctx.recordProcessed('completed', { reason: 'codeman-assistant' });
      ctx.markIdle('codeman-assistant');
      return { handled: true, queuedFinal, counts };
    };
    api.on('reply_dispatch', async (event, ctx) => {
      const task = dispatch(event, ctx);
      dispatches.add(task);
      try {
        return await task;
      } catch {
        api.logger?.error?.('Codeman conversation dispatch needs review');
        return { handled: true, queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
      } finally {
        dispatches.delete(task);
      }
    });
    api.on('message_sent', (event, ctx) => router?.observeOpenClaw(event, ctx));
    // Authenticated, fixture-only operator check: no private chat state or task execution.
    api.registerGatewayMethod?.('codeman-assistant.routingCheck', async ({ respond }) => {
      try {
        const id = 'a'.repeat(64);
        const exchanges = [
          {
            id,
            owner: 'brain',
            user: 'Find an earlier meeting with Craig',
            answer: 'Tuesday 5–5:30 PM Dubai is free. Wednesday is still booked.',
            at: Date.now(),
            visibleAt: Date.now(),
          },
        ];
        const checks = [];
        const cases = [
          { message: 'move to Tuesday', expected: 'brain', exchanges, pendingQuestions: [] },
          { message: 'what is the server health?', expected: 'openclaw', exchanges, pendingQuestions: [] },
          {
            message: 'move it to Tuesday',
            expected: 'clarify',
            exchanges: [
              {
                ...exchanges[0],
                user: 'Find earlier times for BOTH my Craig meeting and my Maya meeting.',
                answer: 'Craig is free Tuesday 5 PM and Maya Tuesday 6 PM. Both Wednesday meetings remain booked.',
              },
            ],
            pendingQuestions: [],
          },
          {
            message: 'purple',
            expected: 'brain',
            answerQuestion: true,
            exchanges: [
              {
                ...exchanges[0],
                user: 'Ask me which test color to use.',
                answer: 'Which color should I use?',
                question: true,
              },
            ],
            pendingQuestions: [{ parentId: id, receipt: 'FIXTURE_QUESTION', text: 'Which color should I use?' }],
          },
        ];
        for (const c of cases) {
          const started = Date.now();
          const result = await classifyConversation(
            api.runtime,
            {
              message: c.message,
              now: Date.now(),
              foregroundId: id,
              exchanges: c.exchanges,
              pendingQuestions: c.pendingQuestions,
            },
            20000
          );
          checks.push({
            message: c.message,
            route: result.route,
            answerQuestion: result.answerQuestion,
            expected: c.expected,
            passed:
              result.route === c.expected &&
              typeof result.answerQuestion === 'boolean' &&
              (c.expected !== 'brain' || result.parentId === id) &&
              (c.answerQuestion !== true || result.answerQuestion === true),
            durationMs: Date.now() - started,
          });
        }
        respond(true, { passed: checks.every((c) => c.passed), checks });
      } catch {
        respond(false, undefined, { code: -32000, message: 'Tool-free routing check unavailable or timed out' });
      }
    });
    api.registerService({
      id: 'codeman-assistant-outbox',
      async start(ctx) {
        deliver = async (destination, text) => {
          const adapter = await api.runtime.channel.outbound.loadAdapter(destination.channel ?? 'telegram');
          if (!adapter?.sendText) throw new Error('Channel delivery adapter unavailable');
          if (!validAnswerPart(text)) throw new Error('Unsupported answer part');
          const payload = {
            cfg: ctx.config,
            accountId: destination.accountId,
            to: destination.chatId,
            signal: AbortSignal.timeout(10000),
          };
          let receipt;
          if (typeof text === 'string') receipt = await adapter.sendText({ ...payload, text });
          else {
            if (destination.channel !== 'whatsapp' || !adapter.sendMedia)
              throw new Error('Document adapter unavailable');
            const root = join(ctx.stateDir, 'codeman-assistant-exports');
            mkdirSync(root, { recursive: true, mode: 0o700 });
            const info = lstatSync(root);
            if (!info.isDirectory() || info.isSymbolicLink() || info.mode & 0o077)
              throw new Error('Export directory requires review');
            const directory = mkdtempSync(join(root, 'send-'));
            try {
              const path = join(directory, text.name);
              writeFileSync(path, text.data, { mode: 0o600, flag: 'wx' });
              receipt = await adapter.sendMedia({
                ...payload,
                text: text.name,
                mediaUrl: path,
                mediaLocalRoots: [directory],
                forceDocument: true,
              });
            } finally {
              rmSync(directory, { recursive: true, force: true });
            }
          }
          connector?.rememberReplyTarget(destination, String(receipt?.messageId ?? ''));
          return receipt;
        };
        if (config.contextRouting !== false)
          router = new ConversationRouter({
            path: join(ctx.stateDir, 'codeman-assistant-routing.json'),
            classify: (facts) => classifyConversation(api.runtime, facts),
          });
        connector = new Connector({
          config,
          outbox: new Outbox(join(ctx.stateDir, 'codeman-assistant-outbox.json')),
          token: () => process.env[config.tokenEnv],
          deliver,
          routing: router,
        });
        const pump = () => {
          if (running) return;
          running = connector
            .tick()
            .catch(() => api.logger.error('Codeman connector requires outbox reconciliation'))
            .finally(() => {
              running = undefined;
            });
        };
        api.logger?.info?.('Codeman assistant connector service started');
        pump();
        timer = setInterval(pump, 2000);
        timer.unref();
      },
      async stop() {
        clearInterval(timer);
        if (connector) connector.stopped = true;
        await running;
        await Promise.allSettled([...dispatches]);
        connector = undefined;
        router = undefined;
        deliver = undefined;
      },
    });
  },
};
