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
    api.on('inbound_claim', async (event, ctx) => {
      if (!connector) {
        return /^\/brain(?:\s|$)/.test(event.content ?? '')
          ? { handled: true, reply: { text: 'Codeman connector is starting or unavailable.' } }
          : { handled: false };
      }
      return connector.inbound(event, ctx);
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
