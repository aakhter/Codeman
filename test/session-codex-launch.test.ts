import { describe, expect, it, vi } from 'vitest';
import { Session } from '../src/session.js';
import type { CreateSessionOptions, RespawnPaneOptions } from '../src/mux-interface.js';

type LaunchHandoff = {
  respawnPaneOptions: RespawnPaneOptions;
  createSessionOptions: CreateSessionOptions;
};

describe('local Codex launch command handoff', () => {
  it('passes the resolved command to both initial mux creation and pane respawn', async () => {
    const command = 'exec /home/ubuntu/.local/bin/codx cisco';
    const session = new Session({
      workingDir: '/tmp',
      mode: 'codex',
      useMux: true,
      codexConfig: { baseCommand: command },
      mux: { backend: 'test', isAvailable: () => true, setAttached: vi.fn() },
    } as ConstructorParameters<typeof Session>[0]);
    let handoff: LaunchHandoff | undefined;
    const internals = session as unknown as {
      _setupOrAttachMuxSession: (options: LaunchHandoff) => Promise<{ isRestored: boolean }>;
      ptyProcess: unknown;
    };
    internals._setupOrAttachMuxSession = vi.fn(async (options) => {
      handoff = options;
      internals.ptyProcess = {
        pid: 1234,
        onData: vi.fn(),
        onExit: vi.fn(),
        resize: vi.fn(),
        write: vi.fn(),
        kill: vi.fn(),
      };
      return { isRestored: true };
    });

    await session.startInteractive();

    expect(handoff?.createSessionOptions.codexConfig?.baseCommand).toBe(command);
    expect(handoff?.respawnPaneOptions.codexConfig?.baseCommand).toBe(command);
    expect(session.toState().codexConfig).not.toHaveProperty('baseCommand');
    expect(session.toDetailedState().codexConfig).not.toHaveProperty('baseCommand');
    expect(session.getResolvedCodexCommandForPersist()).toBe(command);
    await session.stop(false);
  });
});
