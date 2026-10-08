import { join } from 'node:path';
import { Connector, Outbox, validateConfig } from './connector.mjs';

export default {
  id: 'codeman-assistant',
  name: 'Codeman Assistant',
  register(api) {
    const config = validateConfig(api.pluginConfig ?? {});
    let connector;
    let timer;
    let running;
    const inbound = async (event, ctx) => {
      if (!connector) {
        return /^\/brain(?:\s|$)/.test(event.content ?? '')
          ? { handled: true, reply: { text: 'Codeman connector is starting or unavailable.' } }
          : { handled: false };
      }
      return connector.inbound(event, ctx);
    };
    // inbound_claim only runs for plugin-owned conversation bindings. Ordinary
    // Telegram chats need reply_dispatch, which also retains CommandAuthorized,
    // stable message IDs and thread metadata that before_dispatch omits.
    api.on('inbound_claim', inbound);
    api.on('reply_dispatch', async (event, ctx) => {
      const source = event.ctx ?? {};
      const content = source.BodyForCommands ?? source.RawBody ?? '';
      const channel = source.OriginatingChannel ?? source.Surface ?? source.Provider;
      if (channel !== 'telegram' || typeof content !== 'string' || !/^\/brain(?:\s|$)/.test(content))
        return { handled: false };
      const counts = { tool: 0, block: 0, final: 0 };
      if (
        event.isTailDispatch ||
        source.InternalTurnSource != null ||
        event.sendPolicy !== 'allow' ||
        event.suppressUserDelivery
      )
        return { handled: true, queuedFinal: false, counts };
      const result = await inbound(
        {
          content,
          channel,
          isGroup: source.ChatType === 'direct' ? false : true,
          commandAuthorized: source.CommandAuthorized,
          threadId: source.MessageThreadId,
        },
        {
          channelId: channel,
          accountId: source.AccountId,
          conversationId: source.OriginatingTo ?? source.To,
          senderId: source.SenderId,
          messageId: source.MessageSidFull ?? source.MessageSid,
        }
      );
      if (!result.handled) return { handled: false };
      let queuedFinal = false;
      if (result.reply) {
        queuedFinal = ctx.dispatcher.sendFinalReply(result.reply);
        if (queuedFinal) counts.final = 1;
      }
      ctx.recordProcessed('completed', { reason: 'codeman-assistant' });
      ctx.markIdle('codeman-assistant');
      return { handled: true, queuedFinal, counts };
    });
    api.registerService({
      id: 'codeman-assistant-outbox',
      async start(ctx) {
        connector = new Connector({
          config,
          outbox: new Outbox(join(ctx.stateDir, 'codeman-assistant-outbox.json')),
          token: () => process.env[config.tokenEnv],
          deliver: async (destination, text) => {
            const adapter = await api.runtime.channel.outbound.loadAdapter('telegram');
            if (!adapter?.sendText) throw new Error('Telegram delivery adapter unavailable');
            return adapter.sendText({
              cfg: ctx.config,
              accountId: destination.accountId,
              to: destination.chatId,
              text,
              signal: AbortSignal.timeout(10000),
            });
          },
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
        connector = undefined;
      },
    });
  },
};
