import { execSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { TmuxManager, type TmuxPaneTextExecutor } from '../src/tmux-manager.js';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execSync: vi.fn(() => {
      throw new Error('capturePaneTextAsync must not call execSync');
    }),
  };
});

function managerWith(execute: TmuxPaneTextExecutor): TmuxManager {
  return new TmuxManager({ paneTextExecutor: execute });
}

describe('TmuxManager.capturePaneTextAsync', () => {
  it('returns a promise and captures the active pane with one plain bounded command', async () => {
    const execute = vi.fn<TmuxPaneTextExecutor>().mockResolvedValue({ stdout: 'working frame\n' });
    const manager = managerWith(execute);

    const pending = manager.capturePaneTextAsync('codeman-acde-1234');

    expect(pending).toBeInstanceOf(Promise);
    await expect(pending).resolves.toBe('working frame\n');
    expect(execute).toHaveBeenCalledTimes(1);

    const [file, args, options] = execute.mock.calls[0]!;
    expect(file).toBe('tmux');
    expect(args).toEqual(['-L', manager.muxSocket, 'capture-pane', '-p', '-S', '-200', '-t', 'codeman-acde-1234']);
    expect(options).toEqual(
      expect.objectContaining({
        encoding: 'utf8',
        timeout: 1_500,
        maxBuffer: 256 * 1024,
      })
    );
    expect(args).not.toContain('-e');
    expect(args).not.toContain('list-panes');
    expect(args).not.toContain('display-message');
    expect(args).not.toContain('-');
  });

  it.each([
    { requested: 1, expected: '-1' },
    { requested: 0.9, expected: '-1' },
    { requested: 42.9, expected: '-42' },
    { requested: 99_999, expected: '-500' },
    { requested: 0, expected: '-200' },
    { requested: -10, expected: '-200' },
    { requested: Number.NaN, expected: '-200' },
    { requested: '1; list-sessions', expected: '-200' },
  ])('sanitizes lastLines=$requested to $expected', async ({ requested, expected }) => {
    const execute = vi.fn<TmuxPaneTextExecutor>().mockResolvedValue({ stdout: '' });
    const manager = managerWith(execute);

    await manager.capturePaneTextAsync('codeman-acde-1234', { lastLines: requested as number });

    expect(execute.mock.calls[0]![1]).toEqual([
      '-L',
      manager.muxSocket,
      'capture-pane',
      '-p',
      '-S',
      expected,
      '-t',
      'codeman-acde-1234',
    ]);
  });

  it.each(['bad; touch /tmp/injected', 'codeman-safe $(touch /tmp/injected)', 'codeman-safe\nlist-sessions', '--help'])(
    'rejects an invalid or injectable mux target without spawning: %s',
    async (muxName) => {
      const execute = vi.fn<TmuxPaneTextExecutor>().mockResolvedValue({ stdout: 'unexpected' });
      const manager = managerWith(execute);

      await expect(manager.capturePaneTextAsync(muxName)).resolves.toBeNull();
      expect(execute).not.toHaveBeenCalled();
    }
  );

  it('passes an AbortSignal to the child and returns null when aborted', async () => {
    const controller = new AbortController();
    const execute = vi.fn<TmuxPaneTextExecutor>().mockImplementation(async (_file, _args, options) => {
      expect(options.signal).toBe(controller.signal);
      controller.abort();
      throw Object.assign(new Error('aborted'), { name: 'AbortError', code: 'ABORT_ERR' });
    });
    const manager = managerWith(execute);

    await expect(manager.capturePaneTextAsync('codeman-acde-1234', { signal: controller.signal })).resolves.toBeNull();
  });

  it.each([
    Object.assign(new Error('timed out'), { killed: true, signal: 'SIGTERM' }),
    Object.assign(new Error('pane not found'), { code: 1 }),
    Object.assign(new Error('stdout maxBuffer length exceeded'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }),
  ])('returns null without noisy logging when the child fails', async (failure) => {
    const execute = vi.fn<TmuxPaneTextExecutor>().mockRejectedValue(failure);
    const manager = managerWith(execute);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(manager.capturePaneTextAsync('codeman-acde-1234')).resolves.toBeNull();
    expect(error).not.toHaveBeenCalled();

    error.mockRestore();
  });

  it('returns null if an injected child resolves with oversized output', async () => {
    const execute = vi.fn<TmuxPaneTextExecutor>().mockResolvedValue({ stdout: 'x'.repeat(256 * 1024 + 1) });
    const manager = managerWith(execute);

    await expect(manager.capturePaneTextAsync('codeman-acde-1234')).resolves.toBeNull();
  });

  it('does not block a zero-delay event-loop sentinel while the child is pending', async () => {
    let release!: () => void;
    const childFinished = new Promise<void>((resolve) => {
      release = resolve;
    });
    const execute = vi.fn<TmuxPaneTextExecutor>().mockImplementation(async () => {
      await childFinished;
      return { stdout: 'later' };
    });
    const manager = managerWith(execute);
    const order: string[] = [];

    const pending = manager.capturePaneTextAsync('codeman-acde-1234').then((value) => {
      order.push(`capture:${value}`);
    });
    const sentinel = new Promise<void>((resolve) => {
      setTimeout(() => {
        order.push('sentinel');
        resolve();
      }, 0);
    });

    await sentinel;
    expect(order).toEqual(['sentinel']);
    release();
    await pending;
    expect(order).toEqual(['sentinel', 'capture:later']);
  });

  it('does not use the synchronous capture paths', async () => {
    const execute = vi.fn<TmuxPaneTextExecutor>().mockResolvedValue({ stdout: 'frame' });
    const manager = managerWith(execute);
    const activeCapture = vi.spyOn(manager, 'captureActivePaneBuffer');

    await manager.capturePaneTextAsync('codeman-acde-1234');

    expect(execSync).not.toHaveBeenCalled();
    expect(activeCapture).not.toHaveBeenCalled();
  });
});
