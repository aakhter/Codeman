/** @fileoverview Local operator tools. No authenticated server or agent environment is required. */
import type { Command } from 'commander';
import { LocalTerminal, type LocalTarget, type LocalStageOptions } from './local-terminal.js';

export function registerLocalCommands(program: Command): void {
  const local = program
    .command('local')
    .description('Explicit local tmux inspection and guarded input (never an HTTP API)');
  const targetOptions = (command: Command) =>
    command
      .requiredOption('--tmux-socket <name>', 'Explicit tmux socket name (-L)')
      .requiredOption('--target <pane>', 'Explicit tmux pane target')
      .option('--json', 'Machine-readable result');
  const act = async (action: () => Promise<unknown>, json = false) => {
    try {
      const result = await action();
      console.log(json ? JSON.stringify(result) : JSON.stringify(result, null, 2));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(json ? JSON.stringify({ success: false, error: message }) : message);
      process.exitCode = 1;
    }
  };
  const target = (options: { tmuxSocket: string; target: string }): LocalTarget => ({
    socket: options.tmuxSocket,
    target: options.target,
  });
  targetOptions(local.command('inspect').description('Read a bounded, nonincremental pane snapshot'))
    .option('--max-bytes <n>', 'UTF8 evidence budget (1–65536)', '8192')
    .action((options: { tmuxSocket: string; target: string; maxBytes: string; json?: boolean }) =>
      act(() => new LocalTerminal().inspect({ ...target(options), maxBytes: Number(options.maxBytes) }), options.json)
    );
  targetOptions(
    local.command('stage').description('Paste without Enter into a verified empty composer; issue a one-shot receipt')
  )
    .requiredOption('--mode <mode>', 'Installed CLI mode with a characterized Codex or Claude composer profile')
    .requiredOption('--message-file <path>', 'Regular UTF8 message file; one trailing newline is normalized')
    .option('--multiline', 'Explicitly authorize multiline bracketed paste')
    .action(
      (options: {
        tmuxSocket: string;
        target: string;
        mode: LocalStageOptions['mode'];
        messageFile: string;
        multiline?: boolean;
        json?: boolean;
      }) =>
        act(
          () =>
            new LocalTerminal().stage({
              ...target(options),
              mode: options.mode,
              messageFile: options.messageFile,
              multiline: options.multiline,
            }),
          options.json
        )
    );
  targetOptions(
    local.command('submit').description('Consume a receipt and deliver Enter once if the exact composer still matches')
  )
    .requiredOption('--stage-id <uuid>', 'Stage receipt UUID')
    .requiredOption('--confirm-sha <sha256>', 'Exact hash from the stage receipt')
    .action((options: { tmuxSocket: string; target: string; stageId: string; confirmSha: string; json?: boolean }) =>
      act(
        () =>
          new LocalTerminal().submit({ ...target(options), stageId: options.stageId, confirmSha: options.confirmSha }),
        options.json
      )
    );
}
